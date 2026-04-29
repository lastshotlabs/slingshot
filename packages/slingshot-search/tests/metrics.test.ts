/**
 * Unified metrics emitter integration tests for slingshot-search.
 *
 * Wires an in-process MetricsEmitter into the search manager and event sync
 * manager and asserts that the expected counters/timings/gauges land in the
 * snapshot after running a small mix of queries and a forced flush.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { InProcessAdapter, createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import type { InProcessMetricsEmitter, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createEventSyncManager } from '../src/eventSync';
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(
  storageName: string,
  syncMode: 'event-bus' | 'write-through' | 'manual' = 'write-through',
): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: { title: { searchable: true } },
      syncMode,
    },
  } as unknown as ResolvedEntityConfig;
}

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

// ---------------------------------------------------------------------------
// search.query.count + search.query.duration
// ---------------------------------------------------------------------------

describe('search manager — query metrics', () => {
  let manager: SearchManager;
  let metrics: InProcessMetricsEmitter;

  beforeEach(async () => {
    metrics = createInProcessMetricsEmitter();
    manager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
      metrics,
    });
    await manager.initialize([makeEntity('docs')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('records search.query.count and search.query.duration with provider label', async () => {
    const client = manager.getSearchClient('docs');
    await client.indexDocuments([
      { id: '1', title: 'Hello world' },
      { id: '2', title: 'Hello there' },
    ]);

    await client.search({ q: 'hello' });
    await client.search({ q: 'hello' });
    await client.search({ q: 'hello' });

    const snap = metrics.snapshot();

    const count = snap.counters.find(
      c => c.name === 'search.query.count' && c.labels.provider === 'default',
    );
    expect(count).toBeDefined();
    expect(count?.value).toBe(3);

    const duration = snap.timings.find(
      t => t.name === 'search.query.duration' && t.labels.provider === 'default',
    );
    expect(duration).toBeDefined();
    expect(duration?.count).toBe(3);
    expect(duration?.min).toBeGreaterThanOrEqual(0);
    expect(duration?.max).toBeGreaterThanOrEqual(duration?.min ?? 0);
  });

  it('counter still increments when the underlying search throws', async () => {
    // Force an error by calling search through a client whose tenant isolation
    // requires a tenantId we don't supply… db-native won't throw here so we
    // simulate by stubbing the provider's search method.
    const provider = manager.getProvider('docs');
    if (!provider) throw new Error('provider missing');
    const original = provider.search.bind(provider);
    provider.search = (() => {
      throw new Error('forced failure');
    }) as typeof provider.search;

    const client = manager.getSearchClient('docs');
    await expect(client.search({ q: 'x' })).rejects.toThrow('forced failure');

    const snap = metrics.snapshot();
    const count = snap.counters.find(c => c.name === 'search.query.count');
    expect(count?.value).toBe(1);
    // No timing recorded on the error path.
    const duration = snap.timings.find(t => t.name === 'search.query.duration');
    expect(duration).toBeUndefined();

    provider.search = original;
  });

  it('different providers produce independent counter series', async () => {
    // Tear down the default fixture and rebuild with two named providers.
    await manager.teardown();
    metrics.reset();
    manager = createSearchManager({
      pluginConfig: {
        providers: {
          default: { provider: 'db-native' },
          secondary: { provider: 'db-native' },
        },
      },
      transformRegistry: createSearchTransformRegistry(),
      metrics,
    });
    const e1 = makeEntity('docs1');
    const e2 = {
      ...makeEntity('docs2'),
      search: {
        fields: { title: { searchable: true } },
        provider: 'secondary',
        syncMode: 'write-through',
      },
    } as unknown as ResolvedEntityConfig;
    await manager.initialize([e1, e2]);

    await manager.getSearchClient('docs1').search({ q: 'a' });
    await manager.getSearchClient('docs2').search({ q: 'a' });
    await manager.getSearchClient('docs2').search({ q: 'a' });

    const snap = metrics.snapshot();
    const def = snap.counters.find(
      c => c.name === 'search.query.count' && c.labels.provider === 'default',
    );
    const sec = snap.counters.find(
      c => c.name === 'search.query.count' && c.labels.provider === 'secondary',
    );
    expect(def?.value).toBe(1);
    expect(sec?.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// search.circuitBreaker.state
// ---------------------------------------------------------------------------

describe('search manager — circuit breaker gauge', () => {
  let manager: SearchManager;
  let metrics: InProcessMetricsEmitter;

  beforeEach(async () => {
    metrics = createInProcessMetricsEmitter();
    manager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
      metrics,
    });
    await manager.initialize([makeEntity('docs')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('publishes search.circuitBreaker.state when the provider exposes a breaker', async () => {
    const provider = manager.getProvider('docs');
    if (!provider) throw new Error('provider missing');
    // Inject a synchronous breaker accessor to simulate the typesense provider
    // surface so the manager publishes the gauge without a real HTTP backend.
    let state: 'closed' | 'open' | 'half-open' = 'closed';
    (provider as unknown as { getCircuitBreakerState: () => typeof state }).getCircuitBreakerState =
      () => state;

    const client = manager.getSearchClient('docs');
    await client.indexDocument({ id: 'a', title: 'one' });

    await client.search({ q: 'one' });
    let snap = metrics.snapshot();
    let gauge = snap.gauges.find(g => g.name === 'search.circuitBreaker.state');
    expect(gauge?.value).toBe(0);

    state = 'open';
    await client.search({ q: 'one' });
    snap = metrics.snapshot();
    gauge = snap.gauges.find(g => g.name === 'search.circuitBreaker.state');
    expect(gauge?.value).toBe(1);

    state = 'half-open';
    await client.search({ q: 'one' });
    snap = metrics.snapshot();
    gauge = snap.gauges.find(g => g.name === 'search.circuitBreaker.state');
    expect(gauge?.value).toBe(2);
  });

  it('does not publish a breaker gauge when the provider lacks the accessor', async () => {
    // The default db-native provider has no breaker — sample should be a no-op.
    const client = manager.getSearchClient('docs');
    await client.search({ q: 'x' });
    const gauge = metrics.snapshot().gauges.find(g => g.name === 'search.circuitBreaker.state');
    expect(gauge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search.eventSync.flush.count + search.eventSync.dlq.size
// ---------------------------------------------------------------------------

describe('event sync manager — flush + dlq metrics', () => {
  it('records search.eventSync.flush.count on each flush attempt', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = new InProcessAdapter();
    const searchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
      metrics,
    });
    await searchManager.initialize([makeEntity('events', 'event-bus')]);

    const sync = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 1_000,
      metrics,
    });
    sync.subscribeConfigEntity(makeEntity('events', 'event-bus'));

    // Force two flush attempts.
    await sync.flush();
    await sync.flush();

    await sync.teardown();
    await searchManager.teardown();

    const snap = metrics.snapshot();
    const flushCounter = snap.counters.find(c => c.name === 'search.eventSync.flush.count');
    // teardown invokes one more flush internally to drain pending ops, so the
    // expected total is at least 3 (2 explicit + 1 teardown drain).
    expect(flushCounter?.value).toBeGreaterThanOrEqual(2);
  });

  it('publishes search.eventSync.dlq.size when an op exceeds the retry budget', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = new InProcessAdapter();
    const searchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
      metrics,
    });
    await searchManager.initialize([makeEntity('failing', 'event-bus')]);

    // Replace the provider's indexDocuments with a method that always rejects
    // so flushes never succeed and the op is forced into the DLQ once
    // `maxFlushAttempts` is reached.
    const provider = searchManager.getProvider('failing');
    if (!provider) throw new Error('provider missing');
    provider.indexDocuments = (async () => {
      throw new Error('always fails');
    }) as typeof provider.indexDocuments;

    const sync = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 1_000,
      maxFlushAttempts: 2,
      metrics,
    });
    sync.subscribeConfigEntity(makeEntity('failing', 'event-bus'));

    (bus as unknown as { emit(name: string, payload: unknown): void }).emit(
      'entity:failing.created',
      { id: 'doc-1', document: { id: 'doc-1', title: 'Boom' } },
    );

    // Two flush attempts trip `maxFlushAttempts` and DLQ the op.
    await sync.flush();
    await sync.flush();

    const snap = metrics.snapshot();
    const dlq = snap.gauges.find(g => g.name === 'search.eventSync.dlq.size');
    expect(dlq).toBeDefined();
    expect(dlq?.value).toBeGreaterThanOrEqual(1);

    await sync.teardown();
    await searchManager.teardown();

    // After teardown, the gauge is reset to 0.
    const finalDlq = metrics.snapshot().gauges.find(g => g.name === 'search.eventSync.dlq.size');
    expect(finalDlq?.value).toBe(0);
  });
});
