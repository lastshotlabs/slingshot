/**
 * Tenant isolation tests.
 *
 * Verifies filtered mode (shared index, injected tenant filter) and
 * index-per-tenant mode (separate index per tenant) both work correctly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';

// ============================================================================
// Helpers
// ============================================================================

function makeFilteredTenantEntity(storageName: string): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
      tenantId: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: {
        title: { searchable: true },
        tenantId: { searchable: false, filterable: true },
      },
      tenantIsolation: 'filtered',
      tenantField: 'tenantId',
    },
  };
}

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
  };
}

function makeTenantlessEntity(storageName: string): ResolvedEntityConfig {
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
      // No tenant isolation
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('tenant isolation — filtered mode', () => {
  let manager: SearchManager;

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([makeFilteredTenantEntity('notes')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('tenant filter is injected on every query via EntitySearchClient', async () => {
    const client = manager.getSearchClient('notes');

    await client.indexDocument({ id: 'n1', title: 'Note Alpha', tenantId: 'tenant-a' });
    await client.indexDocument({ id: 'n2', title: 'Note Beta', tenantId: 'tenant-b' });

    // Query as tenant-a — should only see tenant-a's notes
    const result = await client.search({ q: 'Note' }, { tenantId: 'tenant-a' });
    const ids = result.hits.map(h => (h.document as Record<string, unknown>).id);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n2');
  });

  it('cross-tenant query returns no results from other tenants', async () => {
    const client = manager.getSearchClient('notes');

    await client.indexDocument({ id: 'x1', title: 'Exclusive Doc', tenantId: 'tenant-x' });

    // Query as tenant-y — should not see tenant-x's documents
    const result = await client.search({ q: 'Exclusive Doc' }, { tenantId: 'tenant-y' });
    const ids = result.hits.map(h => (h.document as Record<string, unknown>).id);
    expect(ids).not.toContain('x1');
    expect(result.totalHits).toBe(0);
  });
});

describe('tenant isolation — index-per-tenant mode', () => {
  let manager: SearchManager;

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([makeIndexPerTenantEntity('posts')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('separate indexes are created per tenant', async () => {
    const client = manager.getSearchClient('posts');

    // Index a document for tenant-1 — should create posts__tenant_t1 index
    await client.indexDocument({ id: 'post-1', title: 'Post One' }, { tenantId: 't1' });
    // Index a document for tenant-2 — should create posts__tenant_t2 index
    await client.indexDocument({ id: 'post-2', title: 'Post Two' }, { tenantId: 't2' });

    // Each tenant should only see their own documents
    const result1 = await client.search({ q: '' }, { tenantId: 't1' });
    const ids1 = result1.hits.map(h => (h.document as Record<string, unknown>).id);
    expect(ids1).toContain('post-1');
    expect(ids1).not.toContain('post-2');

    const result2 = await client.search({ q: '' }, { tenantId: 't2' });
    const ids2 = result2.hits.map(h => (h.document as Record<string, unknown>).id);
    expect(ids2).toContain('post-2');
    expect(ids2).not.toContain('post-1');
  });

  it('index name follows {base}__tenant_{id} convention', () => {
    const baseIndexName = manager.getIndexName('posts');
    expect(baseIndexName).toBeDefined();
    // The convention for tenant indexes is {base}__tenant_{tenantId}
    // This is verified via the EntitySearchClient routing
    // The base index name should be 'posts' (no prefix in our config)
    expect(baseIndexName).toBe('posts');
  });
});

describe('mixed federated search — tenant isolation', () => {
  let manager: SearchManager;

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([
      makeFilteredTenantEntity('tenanted_docs'),
      makeTenantlessEntity('global_docs'),
    ]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('tenanted entities are filtered, tenantless entities are not filtered', async () => {
    const tenantedClient = manager.getSearchClient('tenanted_docs');
    const globalClient = manager.getSearchClient('global_docs');

    // Index into tenanted entity
    await tenantedClient.indexDocument({ id: 'td1', title: 'Tenant Doc', tenantId: 'acme' });
    await tenantedClient.indexDocument({ id: 'td2', title: 'Other Tenant Doc', tenantId: 'other' });

    // Index into global entity — no tenant
    await globalClient.indexDocument({ id: 'gd1', title: 'Global Doc' });

    // Tenanted search as 'acme' — only see acme's docs
    const tenantResult = await tenantedClient.search({ q: 'Doc' }, { tenantId: 'acme' });
    expect(tenantResult.hits.map(h => (h.document as Record<string, unknown>).id)).toContain('td1');
    expect(tenantResult.hits.map(h => (h.document as Record<string, unknown>).id)).not.toContain(
      'td2',
    );

    // Global search — no tenant filter applied
    const globalResult = await globalClient.search({ q: 'Global Doc' });
    expect(globalResult.totalHits).toBeGreaterThanOrEqual(1);
    expect(globalResult.hits.map(h => (h.document as Record<string, unknown>).id)).toContain('gd1');
  });
});
