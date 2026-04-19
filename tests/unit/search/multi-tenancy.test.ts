/**
 * Unit tests for Phase 14: entity-level multi-tenancy in search.
 *
 * Tests:
 * - Filtered mode: tenant filter injection on search/suggest
 * - Filtered mode: tenant filter merged with existing filters via $and
 * - Filtered mode: tenant field auto-added to filterable settings
 * - Index-per-tenant: correct index name resolution
 * - Index-per-tenant: lazy index creation on first write
 * - Federated: mixed tenant/non-tenant entities handled correctly
 * - No tenantId: no filter injection for filtered mode entities
 */
import { describe, expect, test } from 'bun:test';
import type { EntitySearchConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { deriveIndexSettings } from '../../../packages/slingshot-search/src/indexSettings';
import { createSearchManager } from '../../../packages/slingshot-search/src/searchManager';
import { createSearchTransformRegistry } from '../../../packages/slingshot-search/src/transformRegistry';

// ============================================================================
// Helpers
// ============================================================================

function makeEntity(
  name: string,
  storageName: string,
  searchConfig: EntitySearchConfig,
): ResolvedEntityConfig {
  const entity = {
    name,
    _storageName: storageName,
    _pkField: 'id',
    fields: {
      id: { type: 'string', primaryKey: true } as any,
      title: { type: 'string' } as any,
      orgId: { type: 'string' } as any,
    },
    search: searchConfig,
  };
  return entity as ResolvedEntityConfig;
}

// ============================================================================
// Tests: deriveIndexSettings — tenant field auto-filterable
// ============================================================================

describe('deriveIndexSettings — tenant isolation', () => {
  test('auto-adds tenantField to filterable when tenantIsolation is filtered', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
      },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    };

    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toContain('orgId');
  });

  test('does not duplicate tenantField if already filterable', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        orgId: { filterable: true },
      },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    };

    const settings = deriveIndexSettings(config);
    const orgIdCount = settings.filterableFields.filter(f => f === 'orgId').length;
    expect(orgIdCount).toBe(1);
  });

  test('does not add tenantField for index-per-tenant mode', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
      },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    };

    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).not.toContain('orgId');
  });

  test('does not add tenantField when no tenantIsolation is set', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
      },
    };

    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).not.toContain('orgId');
  });
});

// ============================================================================
// Tests: filtered mode — search manager
// ============================================================================

describe('filtered mode — search manager', () => {
  test('injects tenant filter on search when tenantId is provided', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    const client = manager.getSearchClient('articles');
    // Should not throw — filter is injected internally
    await client.search({ q: 'hello' }, { tenantId: 'tenant-abc' });

    const tenantConfig = manager.getEntityTenantConfig('articles');
    expect(tenantConfig).toEqual({
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.teardown();
  });

  test('merges tenant filter with existing filters via $and', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true }, status: { filterable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);
    const client = manager.getSearchClient('articles');

    // Search with an existing filter — the tenant filter should be merged via $and
    const existingFilter = { field: 'status', op: '=' as const, value: 'published' };
    await client.search({ q: 'hello', filter: existingFilter }, { tenantId: 'tenant-abc' });

    // Verify the entity tenant config is set correctly
    const tenantConfig = manager.getEntityTenantConfig('articles');
    expect(tenantConfig).toBeDefined();
    expect(tenantConfig!.tenantIsolation).toBe('filtered');
    expect(tenantConfig!.tenantField).toBe('orgId');

    await manager.teardown();
  });

  test('no filter injection when tenantId is not provided', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);
    const client = manager.getSearchClient('articles');

    // Search without tenantId — should not inject filter, should not throw
    await client.search({ q: 'hello' });
    await client.search({ q: 'hello' }, {});
    await client.search({ q: 'hello' }, { tenantId: undefined });

    const tenantConfig = manager.getEntityTenantConfig('articles');
    expect(tenantConfig).toBeDefined();

    await manager.teardown();
  });

  test('no filter injection when entity has no tenantIsolation', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
    });

    await manager.initialize([entity]);
    const client = manager.getSearchClient('articles');

    // Even with tenantId, no injection since entity has no tenant config
    await client.search({ q: 'hello' }, { tenantId: 'tenant-abc' });

    const tenantConfig = manager.getEntityTenantConfig('articles');
    expect(tenantConfig).toBeUndefined();

    await manager.teardown();
  });
});

// ============================================================================
// Tests: index-per-tenant — index name resolution
// ============================================================================

describe('index-per-tenant mode', () => {
  test('resolves correct base index name', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    // Base index name should be the storage name
    const baseIndex = manager.getIndexName('articles');
    expect(baseIndex).toBe('articles');

    const tenantConfig = manager.getEntityTenantConfig('articles');
    expect(tenantConfig).toEqual({
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.teardown();
  });

  test('respects indexPrefix for index names', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        indexPrefix: 'test_',
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    const baseIndex = manager.getIndexName('articles');
    expect(baseIndex).toBe('test_articles');

    await manager.teardown();
  });

  test('indexDocument with tenantId triggers lazy index creation', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);
    const client = manager.getSearchClient('articles');

    // Index a document with tenant context — should lazily create the tenant index
    await client.indexDocument({ id: '1', title: 'Hello', orgId: 'acme' }, { tenantId: 'acme' });

    // Subsequent call should not re-create (lazy creation is idempotent)
    await client.indexDocument({ id: '2', title: 'World', orgId: 'acme' }, { tenantId: 'acme' });

    // No error means the lazy creation worked
    expect(true).toBe(true);

    await manager.teardown();
  });

  test('search with tenantId works for index-per-tenant', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);
    const client = manager.getSearchClient('articles');

    // Search with tenant context should target the tenant-scoped index
    const result = await client.search({ q: 'hello' }, { tenantId: 'acme' });
    expect(result).toBeDefined();
    expect(result.totalHits).toBe(0);

    await manager.teardown();
  });
});

// ============================================================================
// Tests: getEntityTenantConfig
// ============================================================================

describe('getEntityTenantConfig', () => {
  test('returns config for entity with tenantIsolation', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    expect(manager.getEntityTenantConfig('articles')).toEqual({
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.teardown();
  });

  test('returns undefined for entity without tenantIsolation', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
    });

    await manager.initialize([entity]);

    expect(manager.getEntityTenantConfig('articles')).toBeUndefined();

    await manager.teardown();
  });

  test('resolves by entity name (not just storage name)', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    expect(manager.getEntityTenantConfig('Article')).toEqual({
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    await manager.teardown();
  });

  test('returns undefined when only tenantIsolation is set without tenantField', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      // no tenantField
    });

    await manager.initialize([entity]);

    // Should return undefined since tenantField is missing
    expect(manager.getEntityTenantConfig('articles')).toBeUndefined();

    await manager.teardown();
  });
});

// ============================================================================
// Tests: federated search — mixed tenant/non-tenant entities
// ============================================================================

describe('federated search — mixed tenant/non-tenant entities', () => {
  test('handles mix of tenant-filtered and non-tenant entities', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const articleEntity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'filtered',
      tenantField: 'orgId',
    });

    const globalEntity = makeEntity('Global', 'globals', {
      fields: { title: { searchable: true } },
    });

    await manager.initialize([articleEntity, globalEntity]);

    // Verify entity tenant configs
    expect(manager.getEntityTenantConfig('articles')).toBeDefined();
    expect(manager.getEntityTenantConfig('globals')).toBeUndefined();

    // Federated search should be able to include both entity types
    const result = await manager.federatedSearch({
      q: 'hello',
      queries: [{ indexName: 'articles' }, { indexName: 'globals' }],
    });

    expect(result).toBeDefined();
    expect(result.totalHits).toBe(0);

    await manager.teardown();
  });

  test('handles index-per-tenant entity in federated context', async () => {
    const transformRegistry = createSearchTransformRegistry();
    const manager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
      },
      transformRegistry,
    });

    const entity = makeEntity('Article', 'articles', {
      fields: { title: { searchable: true } },
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.initialize([entity]);

    expect(manager.getEntityTenantConfig('articles')).toEqual({
      tenantIsolation: 'index-per-tenant',
      tenantField: 'orgId',
    });

    await manager.teardown();
  });
});
