/**
 * Admin rebuild route tests.
 *
 * Tests `POST /admin/indexes/:entity/rebuild` including gate auth, source
 * resolution, audit logging, event emission, and name resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { RESOLVE_REINDEX_SOURCE } from '@lastshotlabs/slingshot-core';
import type { ResolvedEntityConfig, StoreInfra } from '@lastshotlabs/slingshot-core';
import { createAdminRouter } from '../../src/routes/admin';
import { createSearchManager } from '../../src/searchManager';
import type { SearchManager } from '../../src/searchManager';
import { createSearchTransformRegistry } from '../../src/transformRegistry';
import type { SearchAdminGate, SearchPluginConfig } from '../../src/types/config';

// ============================================================================
// Helpers
// ============================================================================

function makeEntity(storageName: string): ResolvedEntityConfig {
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
    },
  } as unknown as ResolvedEntityConfig;
}

async function* arraySource(
  items: Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  for (const item of items) yield item;
}

function makeInfra(
  resolveSource?: (name: string) => AsyncIterable<Record<string, unknown>> | null,
): StoreInfra {
  const infra = {} as unknown as StoreInfra;
  Reflect.set(infra, RESOLVE_REINDEX_SOURCE, resolveSource ?? (() => null));
  return infra;
}

function makeGate(overrides?: Partial<SearchAdminGate>): SearchAdminGate {
  return {
    verifyRequest: async () => true,
    ...overrides,
  };
}

async function buildTestApp(
  manager: SearchManager,
  config: SearchPluginConfig,
  infra: StoreInfra,
): Promise<Hono> {
  const app = new Hono();
  app.route('/search', createAdminRouter(manager, config, infra));
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /admin/indexes/:entity/rebuild', () => {
  let manager: SearchManager;
  const entity = makeEntity('articles');

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([entity]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('returns 200 with documentsIndexed and durationMs on success', async () => {
    const docs = [
      { id: '1', title: 'Alpha' },
      { id: '2', title: 'Beta' },
    ];
    const infra = makeInfra(() => arraySource(docs));
    const app = await buildTestApp(manager, { providers: {}, adminGate: makeGate() }, infra);

    const res = await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.entity).toBe('articles');
    expect(body.documentsIndexed).toBe(2);
    expect(typeof body.durationMs).toBe('number');
  });

  it('returns 403 when no adminGate is configured', async () => {
    const infra = makeInfra(() => arraySource([]));
    const app = await buildTestApp(manager, { providers: {} }, infra);

    const res = await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when verifyRequest returns false', async () => {
    const infra = makeInfra(() => arraySource([]));
    const gate = makeGate({ verifyRequest: async () => false });
    const app = await buildTestApp(manager, { providers: {}, adminGate: gate }, infra);

    const res = await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown entity name', async () => {
    const infra = makeInfra(() => null);
    const app = await buildTestApp(manager, { providers: {}, adminGate: makeGate() }, infra);

    const res = await app.request('/search/admin/indexes/unknown_entity/rebuild', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 when RESOLVE_REINDEX_SOURCE returns null', async () => {
    const infra = makeInfra(() => null);
    const app = await buildTestApp(manager, { providers: {}, adminGate: makeGate() }, infra);

    const res = await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });
    expect(res.status).toBe(422);
  });

  it('calls logAuditEntry with action=reindex and entity storage name', async () => {
    let auditEntry: Record<string, unknown> | undefined;
    const gate = makeGate({
      logAuditEntry: async entry => {
        auditEntry = entry as Record<string, unknown>;
      },
    });
    const infra = makeInfra(() => arraySource([]));
    const app = await buildTestApp(manager, { providers: {}, adminGate: gate }, infra);

    await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });

    expect(auditEntry).toBeDefined();
    expect(auditEntry!.action).toBe('reindex');
    expect(auditEntry!.entity).toBe('articles');
  });

  it('resolves entity by class name (name → storageName)', async () => {
    // Manager initialized with storageName 'articles', class name also 'articles' here.
    // Use a separate entity where name differs from storageName to confirm resolution.
    const entityWithDiffName = {
      name: 'Article',
      _pkField: 'id',
      _storageName: 'articles',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
      },
      search: { fields: { title: { searchable: true } } },
    } as unknown as ResolvedEntityConfig;
    const altManager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
    await altManager.initialize([entityWithDiffName]);

    const infra = makeInfra(() => arraySource([{ id: '1', title: 'Test' }]));
    const app = await buildTestApp(altManager, { providers: {}, adminGate: makeGate() }, infra);

    // Request using class name 'Article'
    const res = await app.request('/search/admin/indexes/Article/rebuild', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.entity).toBe('articles');
    expect(body.documentsIndexed).toBe(1);

    await altManager.teardown();
  });

  it('indexes zero documents when source is empty', async () => {
    const infra = makeInfra(() => arraySource([]));
    const app = await buildTestApp(manager, { providers: {}, adminGate: makeGate() }, infra);

    const res = await app.request('/search/admin/indexes/articles/rebuild', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.documentsIndexed).toBe(0);
  });
});
