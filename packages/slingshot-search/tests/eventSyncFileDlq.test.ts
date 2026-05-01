/**
 * File-backed DLQ store tests.
 *
 * Exercises:
 *  - persist and reload entries across simulated restarts
 *  - `replayDlq()` — re-process entries and remove on success
 *  - auto-compaction at the configured threshold
 *  - `delete()` a single entry
 *  - integration with `createEventSyncManager` via `dlqStoragePath`
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type FileDlqStore,
  type FlushDeadLetterEntry,
  createEventSyncManager,
  createFileDlqStore,
} from '../src/eventSync';
import { createDbNativeProvider } from '../src/providers/dbNative';
import { createSearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';
import type { SearchIndexSettings } from '../src/types/provider';

function makeEntityConfig(storageName: string, pkField = 'id'): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: pkField,
    _storageName: storageName,
    fields: {
      [pkField]: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: { title: { searchable: true } },
      syncMode: 'event-bus',
    },
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

function tmpFile(prefix: string): string {
  const dir = join(tmpdir(), 'slingshot-search-test');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
}

describe('createFileDlqStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile('dlq');
  });

  afterEach(() => {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
  });

  function makeEntry(overrides?: Partial<FlushDeadLetterEntry>): FlushDeadLetterEntry {
    return {
      indexName: 'products',
      entityName: 'products',
      documentId: 'doc-1',
      operation: 'index',
      attempts: 3,
      error: 'persistent failure',
      enqueuedAt: Date.now(),
      ...overrides,
    };
  }

  it('persists entries to disk and reloads them', async () => {
    const store = createFileDlqStore({ storagePath: filePath });
    await store.put(makeEntry({ documentId: 'doc-1' }));
    await store.put(makeEntry({ documentId: 'doc-2' }));

    // Create a new store instance pointing to the same file (simulates restart)
    const store2 = createFileDlqStore({ storagePath: filePath });
    const all = await store2.getAll();
    expect(all).toHaveLength(2);

    const ids = all.map(e => e.documentId).sort();
    expect(ids).toEqual(['doc-1', 'doc-2']);
  });

  it('deletes a single entry by key', async () => {
    const store = createFileDlqStore({ storagePath: filePath });

    await store.put(makeEntry({ documentId: 'doc-1' }));
    await store.put(makeEntry({ documentId: 'doc-2' }));
    await store.put(makeEntry({ documentId: 'doc-3' }));
    expect(await store.getAll()).toHaveLength(3);

    await store.delete('products', 'doc-2');
    const remaining = await store.getAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(e => e.documentId)).toEqual(['doc-1', 'doc-3']);
  });

  it('replayDlq re-processes entries and removes successes', async () => {
    const store = createFileDlqStore({ storagePath: filePath });

    await store.put(makeEntry({ documentId: 'doc-1', operation: 'delete' }));
    await store.put(makeEntry({ documentId: 'doc-2', operation: 'delete' }));
    await store.put(makeEntry({ documentId: 'doc-3', operation: 'delete' }));
    expect(await store.size()).toBe(3);

    const result = await store.replayDlq(async entry => {
      // Simulate success for doc-1 and doc-3, failure for doc-2
      return entry.documentId !== 'doc-2';
    });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);

    // Only doc-2 should remain
    const remaining = await store.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].documentId).toBe('doc-2');
  });

  it('replayDlq handles handler exceptions gracefully', async () => {
    const store = createFileDlqStore({ storagePath: filePath });

    await store.put(makeEntry({ documentId: 'doc-1', operation: 'delete' }));
    await store.put(makeEntry({ documentId: 'doc-2', operation: 'delete' }));

    const result = await store.replayDlq(async entry => {
      if (entry.documentId === 'doc-1') throw new Error('handler crash');
      return true;
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('auto-compacts when exceeding maxEntries, deduplicating by key', async () => {
    // With maxEntries=5, compaction fires when the file reaches 5 entries.
    // After dedup (same key → 1 entry), subsequent puts add fresh lines until
    // the count reaches the threshold again.
    const store = createFileDlqStore({ storagePath: filePath, maxEntries: 5 });

    // Put 8 identical-key entries.
    for (let i = 0; i < 8; i++) {
      await store.put(makeEntry({ documentId: 'doc-1', enqueuedAt: 1000 + i }));
    }

    const all = await store.getAll();
    // Trace:
    //   puts 1-5 (1000-1004): no compaction, 5 entries accumulate
    //   put 6 (1005): compaction triggers → 1 entry (1004), then append 1005 → 2
    //   put 7 (1006): no compaction (2 < 5), append → 3
    //   put 8 (1007): no compaction (3 < 5), append → 4
    expect(all).toHaveLength(4);
    // All entries have the same key — they were deduped during the first
    // compaction (oldest entries 1000-1003 were dropped).
    expect(all[0].documentId).toBe('doc-1');
    expect(all[3].enqueuedAt).toBe(1007);
  });

  it('clear removes the file', async () => {
    const store = createFileDlqStore({ storagePath: filePath });
    await store.put(makeEntry());
    expect(existsSync(filePath)).toBe(true);

    await store.clear();
    expect(existsSync(filePath)).toBe(false);
    expect(await store.size()).toBe(0);
  });

  it('handles empty or missing file gracefully', async () => {
    const store = createFileDlqStore({ storagePath: filePath });
    expect(await store.getAll()).toEqual([]);
    expect(await store.size()).toBe(0);

    // delete on empty store should not throw
    await store.delete('products', 'nonexistent');
    expect(await store.size()).toBe(0);
  });
});

describe('eventSyncManager with dlqStoragePath', () => {
  let bus: InProcessAdapter;
  let provider: ReturnType<typeof createDbNativeProvider>;
  let searchManager: ReturnType<typeof createSearchManager>;
  let filePath: string;

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
    filePath = tmpFile('mgr-dlq');
  });

  afterEach(async () => {
    await provider.teardown();
    await searchManager.teardown();
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
  });

  it('uses file-backed store when dlqStoragePath is set', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 2,
      dlqStoragePath: filePath,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'file-dlq-1',
      document: { id: 'file-dlq-1', title: 'Will Fail' },
    });

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');
    spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent failure'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 5; i++) await mgr.flush();

    errSpy.mockRestore();

    // Entry should be persisted to the file
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('file-dlq-1');

    const health = mgr.getEventSyncHealth();
    expect(health.deadLetterCount).toBe(1);

    await mgr.teardown();
  });

  it('replayDlq re-processes dead-lettered deletions on file store', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 2,
      dlqStoragePath: filePath,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    // Enqueue index operation that will fail
    dynamicBus.emit('entity:products.created', {
      id: 'replay-test',
      document: { id: 'replay-test', title: 'Replay Test' },
    });

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');

    // Make index fail 3 times to DLQ the entry
    const indexSpy = spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await mgr.flush();
    errSpy.mockRestore();

    expect(existsSync(filePath)).toBe(true);

    // Now replayDlq. Since this is an index operation (no doc body),
    // replayDlq attempts a delete. We make that succeed.
    const deleteSpy = spyOn(p, 'deleteDocuments').mockResolvedValue({
      taskId: 'replay-task',
      status: 'succeeded',
      enqueuedAt: new Date(),
    });
    indexSpy.mockRestore();

    const result = await mgr.replayDlq();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // File should be empty after successful replay
    expect(existsSync(filePath)).toBe(false);

    deleteSpy.mockRestore();
    await mgr.teardown();
  });

  it('replayDlq on in-memory store returns zero summary', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 2,
    });

    const result = await mgr.replayDlq();
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);

    await mgr.teardown();
  });
});
