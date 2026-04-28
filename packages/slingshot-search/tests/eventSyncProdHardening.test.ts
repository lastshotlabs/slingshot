/**
 * Prod-hardening coverage for the event-sync manager.
 *
 * Each test maps to a finding from
 * `slingshot-specs/specs/audit.prod-path-readiness.2026-04-28.md`:
 *
 *  - P-SEARCH-5: pluggable DLQ store + structured eviction event
 *  - P-SEARCH-6: teardown awaits in-flight timer flushes
 *  - P-SEARCH-7: HealthCheck contract surfaces flush-backlog gauge data
 *  - P-SEARCH-8: geo transform skip emits structured warn + event
 *  - P-SEARCH-9: token-bucket index rate limiting + overflow modes
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  InProcessAdapter,
  createEventDefinitionRegistry,
  createEventPublisher,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import type {
  Logger,
  ResolvedEntityConfig,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import {
  type DlqStore,
  type FlushDeadLetterEntry,
  createEventSyncManager,
} from '../src/eventSync';
import { createDbNativeProvider } from '../src/providers/dbNative';
import { createSearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';
import type { SearchIndexSettings } from '../src/types/provider';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntityConfig(
  storageName: string,
  overrides?: { geo?: { latField: string; lngField: string } },
): ResolvedEntityConfig {
  const search: Record<string, unknown> = {
    fields: { title: { searchable: true } },
    syncMode: 'event-bus',
  };
  if (overrides?.geo) search.geo = overrides.geo;
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search,
  } as unknown as ResolvedEntityConfig;
}

const BASE_SETTINGS: SearchIndexSettings = {
  searchableFields: ['title'],
  filterableFields: [],
  sortableFields: [],
  facetableFields: [],
};

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

function makeRecordingLogger(): {
  logger: Logger;
  warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
  errors: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {
      /* noop */
    },
    info() {
      /* noop */
    },
    warn(msg, fields) {
      warns.push({ msg, fields: fields as Record<string, unknown> | undefined });
    },
    error(msg, fields) {
      errors.push({ msg, fields: fields as Record<string, unknown> | undefined });
    },
    child() {
      return logger;
    },
  };
  return { logger, warns, errors };
}

function makeEventBundle(): {
  bus: InProcessAdapter;
  events: SlingshotEvents;
  collected: Array<{ key: string; payload: unknown }>;
} {
  const bus = new InProcessAdapter();
  const definitions = createEventDefinitionRegistry();
  for (const key of [
    'search:dlq.evicted',
    'search:geoTransform.skipped',
    'search:sync.dead',
    'search:sync.failed',
  ] as const) {
    definitions.register(
      defineEvent(key, {
        ownerPlugin: 'slingshot-search.test',
        exposure: ['internal'],
        resolveScope() {
          return null;
        },
      }),
    );
  }
  const events = createEventPublisher({
    definitions,
    bus,
  });
  const collected: Array<{ key: string; payload: unknown }> = [];
  for (const key of [
    'search:dlq.evicted',
    'search:geoTransform.skipped',
    'search:sync.dead',
    'search:sync.failed',
  ] as const) {
    bus.on(key, (payload: unknown) => {
      collected.push({ key, payload });
    });
  }
  return { bus, events, collected };
}

describe('event-sync prod-hardening', () => {
  let bus: InProcessAdapter;
  let provider: ReturnType<typeof createDbNativeProvider>;
  let searchManager: ReturnType<typeof createSearchManager>;

  beforeEach(async () => {
    bus = new InProcessAdapter();
    provider = createDbNativeProvider();
    await provider.connect();
    await provider.createOrUpdateIndex('products', BASE_SETTINGS);
    searchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
    });
    await searchManager.initialize([makeEntityConfig('products')]);
  });

  afterEach(async () => {
    await provider.teardown();
    await searchManager.teardown();
  });

  // -------------------------------------------------------------------------
  // P-SEARCH-5
  // -------------------------------------------------------------------------
  describe('P-SEARCH-5: pluggable DLQ store + eviction event', () => {
    it('routes DLQ entries to a custom dlqStore adapter', async () => {
      const entity = makeEntityConfig('products');
      const persisted: FlushDeadLetterEntry[] = [];
      const customStore: DlqStore = {
        async put(entry) {
          persisted.push(entry);
        },
        async getAll() {
          return persisted;
        },
        async delete() {
          /* noop */
        },
      };

      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus,
        flushIntervalMs: 60_000,
        flushThreshold: 100,
        maxFlushAttempts: 1,
        dlqStore: customStore,
      });
      mgr.subscribeConfigEntity(entity);

      const p = searchManager.getProvider('products');
      if (!p) throw new Error('no provider');
      spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent'));

      const dyn = bus as unknown as { emit(event: string, payload: unknown): void };
      dyn.emit('entity:products.created', {
        id: 'custom-1',
        document: { id: 'custom-1', title: 'X' },
      });

      await mgr.flush();
      // Wait for the async store put + refreshDlqCount round-trip.
      await new Promise(r => setTimeout(r, 10));

      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        documentId: 'custom-1',
        operation: 'index',
        attempts: 1,
      });

      await mgr.teardown();
    });

    it('emits a search:dlq.evicted event with the dropped payload on FIFO eviction', async () => {
      const entity = makeEntityConfig('products');
      const { events, collected, bus: bundleBus } = makeEventBundle();
      // Re-initialize the search manager to use the bundle bus so events emit
      // through a real publisher.
      const { logger, errors } = makeRecordingLogger();
      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus: bundleBus,
        events,
        flushIntervalMs: 60_000,
        flushThreshold: 100_000,
        maxFlushAttempts: 1,
        maxDeadLetterEntries: 2,
        logger,
      });
      mgr.subscribeConfigEntity(entity);

      const p = searchManager.getProvider('products');
      if (!p) throw new Error('no provider');
      spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent'));

      const dyn = bundleBus as unknown as { emit(event: string, payload: unknown): void };
      for (let i = 1; i <= 3; i++) {
        dyn.emit('entity:products.created', {
          id: `evict-${i}`,
          document: { id: `evict-${i}`, title: `Doc ${i}` },
        });
        await mgr.flush();
      }

      const evictionEvents = collected.filter(e => e.key === 'search:dlq.evicted');
      expect(evictionEvents).toHaveLength(1);
      const payload = evictionEvents[0]?.payload as Record<string, unknown>;
      expect(payload?.documentId).toBe('evict-1');
      expect(payload?.reason).toBe('capacity');

      // Logger.error called for the eviction (in addition to per-flush errors).
      const evictLog = errors.find(e => e.msg.includes('evicted by capacity bound'));
      expect(evictLog).toBeTruthy();

      await mgr.teardown();
    });
  });

  // -------------------------------------------------------------------------
  // P-SEARCH-6
  // -------------------------------------------------------------------------
  describe('P-SEARCH-6: teardown awaits in-flight timer flushes', () => {
    it('teardown does not return until the timer-driven flush has settled', async () => {
      const entity = makeEntityConfig('products');
      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus,
        flushIntervalMs: 25,
        flushThreshold: 100_000,
        maxFlushAttempts: 5,
      });
      mgr.subscribeConfigEntity(entity);

      const p = searchManager.getProvider('products');
      if (!p) throw new Error('no provider');

      let releaseFlush: (() => void) | undefined;
      const gate = new Promise<void>(resolve => {
        releaseFlush = resolve;
      });
      let flushDone = false;
      const indexSpy = spyOn(p, 'indexDocuments').mockImplementation(async () => {
        await gate;
        flushDone = true;
        return { taskId: 'gated', status: 'enqueued', enqueuedAt: new Date() };
      });

      const dyn = bus as unknown as { emit(event: string, payload: unknown): void };
      dyn.emit('entity:products.created', {
        id: 'await-1',
        document: { id: 'await-1', title: 'X' },
      });

      // Wait for the timer to fire and start the gated flush.
      await new Promise(r => setTimeout(r, 50));

      // Start teardown. It MUST wait until the gated flush settles.
      const teardownPromise = mgr.teardown();
      let teardownResolved = false;
      void teardownPromise.then(() => {
        teardownResolved = true;
      });

      // Give the event loop a chance — teardown should be blocked.
      await new Promise(r => setTimeout(r, 20));
      expect(teardownResolved).toBe(false);

      // Release the flush; teardown can now complete.
      releaseFlush?.();
      await teardownPromise;

      expect(flushDone).toBe(true);
      indexSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // P-SEARCH-7
  // -------------------------------------------------------------------------
  describe('P-SEARCH-7: HealthCheck contract', () => {
    it('getHealth() returns a HealthReport with pending/dlq/lastFlushAt/lastError fields', async () => {
      const entity = makeEntityConfig('products');
      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus,
        flushIntervalMs: 60_000,
        flushThreshold: 100_000,
        maxFlushAttempts: 5,
      });
      mgr.subscribeConfigEntity(entity);

      // Initial state: healthy, lastFlushAt null.
      const initial = mgr.getHealth();
      expect(initial.component).toBe('slingshot-search.eventSync');
      expect(initial.state).toBe('healthy');
      expect(initial.details?.pendingCount).toBe(0);
      expect(initial.details?.dlqCount).toBe(0);
      expect(initial.details?.lastFlushAt).toBeNull();

      const p = searchManager.getProvider('products');
      if (!p) throw new Error('no provider');
      spyOn(p, 'indexDocuments').mockRejectedValueOnce(new Error('boom'));

      const dyn = bus as unknown as { emit(event: string, payload: unknown): void };
      dyn.emit('entity:products.created', {
        id: 'h-1',
        document: { id: 'h-1', title: 'Doc' },
      });

      await mgr.flush();

      const after = mgr.getHealth();
      expect(after.state).toBe('degraded');
      expect(after.message).toBe('boom');
      expect(after.details?.lastFlushAt).not.toBeNull();
      expect(after.details?.pendingCount).toBe(1);

      // After a successful flush, lastError is cleared.
      await mgr.flush();
      const recovered = mgr.getHealth();
      expect(recovered.details?.pendingCount).toBe(0);
      expect((recovered as { message?: string }).message ?? null).toBeNull();

      await mgr.teardown();
    });
  });

  // -------------------------------------------------------------------------
  // P-SEARCH-8
  // -------------------------------------------------------------------------
  describe('P-SEARCH-8: geo transform skip is structured', () => {
    it('emits search:geoTransform.skipped + Logger.warn when latField is missing', async () => {
      const entity = makeEntityConfig('products', {
        geo: { latField: 'lat', lngField: 'lng' },
      });
      const { events, collected, bus: bundleBus } = makeEventBundle();
      const { logger, warns } = makeRecordingLogger();

      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus: bundleBus,
        events,
        flushIntervalMs: 60_000,
        flushThreshold: 100_000,
        logger,
      });
      mgr.subscribeConfigEntity(entity);

      const dyn = bundleBus as unknown as { emit(event: string, payload: unknown): void };
      // Document is missing `lat` — geo transform must be skipped, with a
      // structured warn + event surfacing the diagnostic.
      dyn.emit('entity:products.created', {
        id: 'geo-1',
        document: { id: 'geo-1', title: 'No Lat', lng: 12.34 },
      });

      const skips = collected.filter(e => e.key === 'search:geoTransform.skipped');
      expect(skips).toHaveLength(1);
      const payload = skips[0]?.payload as Record<string, unknown>;
      expect(payload?.documentId).toBe('geo-1');
      expect(payload?.reason).toBe('missingLat');
      expect(payload?.latField).toBe('lat');

      const warnLog = warns.find(w => w.msg.includes('geo transform skipped'));
      expect(warnLog).toBeTruthy();
      expect(warnLog?.fields?.documentId).toBe('geo-1');

      await mgr.teardown();
    });
  });

  // -------------------------------------------------------------------------
  // P-SEARCH-9
  // -------------------------------------------------------------------------
  describe('P-SEARCH-9: index op rate limiting', () => {
    it('drops indexing operations and increments the gauge in drop overflow mode', async () => {
      const entity = makeEntityConfig('products');
      const { events, collected, bus: bundleBus } = makeEventBundle();
      const { logger, warns } = makeRecordingLogger();

      const mgr = createEventSyncManager({
        pluginConfig: PLUGIN_CONFIG,
        searchManager,
        transformRegistry: createSearchTransformRegistry(),
        bus: bundleBus,
        events,
        flushIntervalMs: 60_000,
        flushThreshold: 100_000,
        maxFlushAttempts: 5,
        // Tiny bucket so the second op overflows.
        maxIndexOpsPerSecond: 1,
        indexOverflowMode: 'drop',
        logger,
      });
      mgr.subscribeConfigEntity(entity);

      const dyn = bundleBus as unknown as { emit(event: string, payload: unknown): void };
      dyn.emit('entity:products.created', {
        id: 'rl-1',
        document: { id: 'rl-1', title: 'A' },
      });
      dyn.emit('entity:products.created', {
        id: 'rl-2',
        document: { id: 'rl-2', title: 'B' },
      });

      await mgr.flush();

      const health = mgr.getEventSyncHealth();
      expect(health.droppedFromRateLimit).toBe(1);
      // The dropped op stays in pending so the next flush picks it up.
      expect(health.pendingCount).toBe(1);

      const drops = collected.filter(
        e =>
          e.key === 'search:sync.failed' &&
          (e.payload as Record<string, unknown>)?.error?.toString().includes('rate-limit'),
      );
      expect(drops.length).toBeGreaterThanOrEqual(1);

      const warn = warns.find(w => w.msg.includes('dropped by rate limiter'));
      expect(warn).toBeTruthy();

      await mgr.teardown();
    });
  });
});
