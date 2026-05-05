/**
 * Regression tests for OpenAPI brace-path emission and hono colon-path runtime matching
 * across the bare-entity route generator. The two behaviors must hold simultaneously:
 *
 *   1. `getOpenAPIDocument()` emits `/foos/{id}` style paths (snapshot codegen requires it).
 *   2. The runtime hono matcher still resolves real requests to `/foos/abc123`
 *      (parameterized hono routes use colon form internally).
 *
 * Both behaviors degrade silently if `toOpenApiPath` is dropped from a `createRoute({ path })`
 * site or if the runtime router accidentally receives the brace form. These tests pin both.
 */
import { describe, expect, it } from 'bun:test';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';

interface MemoryRecord {
  id: string;
  name: string;
}

function createMemoryAdapter() {
  const store = new Map<string, MemoryRecord>();
  store.set('abc123', { id: 'abc123', name: 'seed' });
  return {
    create: (data: unknown) => {
      const id = `gen-${store.size + 1}`;
      const record = { id, ...(data as Record<string, unknown>) } as MemoryRecord;
      store.set(id, record);
      return Promise.resolve(record);
    },
    getById: (id: string) => Promise.resolve(store.get(id) ?? null),
    list: () =>
      Promise.resolve({
        items: [...store.values()],
        hasMore: false,
      }),
    update: (id: string, data: unknown) => {
      const existing = store.get(id);
      if (!existing) return Promise.resolve(null);
      const updated = { ...existing, ...(data as Record<string, unknown>) } as MemoryRecord;
      store.set(id, updated);
      return Promise.resolve(updated);
    },
    delete: (id: string) => {
      store.delete(id);
      return Promise.resolve(true);
    },
  };
}

function fooConfig(): ResolvedEntityConfig {
  return {
    _systemFields: {
      createdBy: 'createdBy',
      updatedBy: 'updatedBy',
      ownerField: 'ownerId',
      tenantField: 'tenantId',
      version: 'version',
    },
    _storageFields: {
      mongoPkField: '_id',
      ttlField: '_expires_at',
      mongoTtlField: '_expiresAt',
    },
    _conventions: {},
    name: 'Foo',
    fields: {
      id: {
        type: 'string',
        primary: true,
        immutable: true,
        optional: false,
        default: 'uuid',
        private: false,
      },
      name: {
        type: 'string',
        primary: false,
        immutable: false,
        optional: false,
        private: false,
      },
    },
    _pkField: 'id',
    _storageName: 'foos',
  } as unknown as ResolvedEntityConfig;
}

describe('bare-entity OpenAPI path emission', () => {
  it('OpenAPI document emits brace-form paths for parameterized routes', async () => {
    const router = buildBareEntityRoutes(
      fooConfig(),
      undefined,
      createMemoryAdapter(),
    ) as OpenAPIHono;
    const doc = router.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '0.0.0' },
    });
    const paths = Object.keys(doc.paths ?? {});

    // Collection paths are unparameterized — both forms collapse to `/foos`.
    expect(paths).toContain('/foos');
    // Parameterized paths must be brace form. Colon form here would be a regression.
    expect(paths).toContain('/foos/{id}');
    expect(paths).not.toContain('/foos/:id');
  });

  it('runtime hono router still matches colon-form requests after OpenAPI conversion', async () => {
    const router = buildBareEntityRoutes(
      fooConfig(),
      undefined,
      createMemoryAdapter(),
    ) as OpenAPIHono;

    // GET /foos/abc123 — must reach the runtime handler. If the runtime registration
    // accidentally received the brace form (`/foos/{id}`), hono would not match this
    // path and we'd see 404.
    const res = await router.fetch(new Request('http://localhost/foos/abc123'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryRecord;
    expect(body).toEqual({ id: 'abc123', name: 'seed' });
  });

  it('runtime hono router rejects bracket-form paths in the wire URL', async () => {
    // Defensive: clients hit colon-form URLs (`/foos/abc123`), never bracket form.
    // If runtime registration ever flips to brace form by mistake, this test starts
    // returning 200 — the inverse signal. We expect 404 here.
    const router = buildBareEntityRoutes(
      fooConfig(),
      undefined,
      createMemoryAdapter(),
    ) as OpenAPIHono;
    const res = await router.fetch(new Request('http://localhost/foos/%7Bid%7D'));
    expect(res.status).toBe(404);
  });
});
