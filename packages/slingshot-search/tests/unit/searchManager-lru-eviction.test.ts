/**
 * Tenant index LRU eviction observability tests.
 *
 * Verifies that when the tenant index cache exceeds its configured capacity,
 * the search manager:
 * - Fires the `onTenantIndexEvicted` callback with the correct tenant id and
 *   index name and `reason: 'lru-capacity'`.
 * - Increments the `metrics.tenantIndexEvictions` counter.
 * - Emits a structured eviction log via the injected logger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { LogFields, Logger, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createSearchManager } from '../../src/searchManager';
import type { SearchManager } from '../../src/searchManager';
import { createSearchTransformRegistry } from '../../src/transformRegistry';

function makeIndexPerTenantEntity(storageName: string): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: {
        title: { searchable: true },
      },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'tenantId',
    },
  } as unknown as ResolvedEntityConfig;
}

describe('searchManager — tenant index LRU eviction observability', () => {
  let manager: SearchManager;
  let evictedEvents: Array<{
    tenantId: string;
    indexName: string;
    reason: 'lru-capacity';
  }>;
  let logRecords: Array<{ msg: string; fields?: LogFields }>;
  let logger: Logger;

  beforeEach(async () => {
    evictedEvents = [];
    logRecords = [];
    logger = {
      debug() {},
      info(msg: string, fields?: LogFields) {
        logRecords.push({ msg, fields });
      },
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };

    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
      tenantCacheCapacity: 2,
      onTenantIndexEvicted: event => {
        evictedEvents.push({ ...event });
      },
      logger,
    });
    await manager.initialize([makeIndexPerTenantEntity('items')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('fires the onTenantIndexEvicted callback for the oldest tenant when capacity is exceeded', async () => {
    const client = manager.getSearchClient('items');

    // Add tenant A, B, C in order. With capacity = 2, adding C should evict A.
    await client.indexDocument({ id: 'a-1', title: 'one' }, { tenantId: 'A' });
    await client.indexDocument({ id: 'b-1', title: 'two' }, { tenantId: 'B' });

    // Sanity — no eviction yet.
    expect(evictedEvents).toHaveLength(0);
    expect(manager.metrics.tenantIndexEvictions).toBe(0);

    await client.indexDocument({ id: 'c-1', title: 'three' }, { tenantId: 'C' });

    expect(evictedEvents).toHaveLength(1);
    expect(evictedEvents[0]).toEqual({
      tenantId: 'A',
      indexName: 'items',
      reason: 'lru-capacity',
    });
  });

  it('increments metrics.tenantIndexEvictions to 1 after one eviction', async () => {
    const client = manager.getSearchClient('items');

    await client.indexDocument({ id: 'a-1', title: 'one' }, { tenantId: 'A' });
    await client.indexDocument({ id: 'b-1', title: 'two' }, { tenantId: 'B' });
    await client.indexDocument({ id: 'c-1', title: 'three' }, { tenantId: 'C' });

    expect(manager.metrics.tenantIndexEvictions).toBe(1);
  });

  it('emits a structured log line on eviction', async () => {
    const client = manager.getSearchClient('items');

    await client.indexDocument({ id: 'a-1', title: 'one' }, { tenantId: 'A' });
    await client.indexDocument({ id: 'b-1', title: 'two' }, { tenantId: 'B' });
    await client.indexDocument({ id: 'c-1', title: 'three' }, { tenantId: 'C' });

    const evictionRecord = logRecords.find(r => r.msg.includes('tenant index cache evicted'));
    expect(evictionRecord).toBeDefined();
    expect(evictionRecord!.fields?.reason).toBe('lru-capacity');
    expect(evictionRecord!.fields?.tenantId).toBe('A');
    expect(evictionRecord!.fields?.indexName).toBe('items');
    expect(evictionRecord!.fields?.capacity).toBe(2);
  });
});
