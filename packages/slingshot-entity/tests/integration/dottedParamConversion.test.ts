/**
 * Regression: ops that reference dotted context params (`'param:actor.id'`) must
 * not leak the dotted identifier into the OpenAPI path or zod request schema.
 * Snapshot codegen produces invalid TS identifiers (`ByActor.idResponse`) when a
 * `{actor.id}` segment lands in the spec; the runtime injects those values from
 * `getActor(c)` so the URL doesn't need them.
 */
import { describe, expect, it } from 'bun:test';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { defineEntity, defineOperations, field, op } from '../../src/index';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';

const Note = defineEntity('Note', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string(),
    text: field.string(),
  },
});

const noteOps = defineOperations(Note, {
  // Dotted context param — must NOT appear in the URL path.
  listByUser: op.lookup({
    fields: { userId: 'param:actor.id' },
    returns: 'many',
  }),
  // Mixed — `tenantId` is a real URL param, `actor.id` is context.
  listByTenantAndActor: op.lookup({
    fields: { tenantId: 'param:tenantId', userId: 'param:actor.id' },
    returns: 'many',
  }),
  // Dot-free op — sanity check it still emits the param normally.
  getByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'one',
  }),
});

function memoryAdapter() {
  return {
    create: () => Promise.resolve({}),
    getById: () => Promise.resolve(null),
    list: () => Promise.resolve({ items: [], hasMore: false }),
    update: () => Promise.resolve(null),
    delete: () => Promise.resolve(true),
    listByUser: () => Promise.resolve({ items: [], hasMore: false }),
    listByTenantAndActor: () => Promise.resolve({ items: [], hasMore: false }),
    getByUser: () => Promise.resolve(null),
  } as never;
}

describe('dynamic builder — dotted-param paths', () => {
  it('omits dotted context params from generated OpenAPI paths', () => {
    const router = buildBareEntityRoutes(
      Note,
      noteOps.operations,
      memoryAdapter(),
    ) as OpenAPIHono;
    const doc = router.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'note-test', version: '0.0.0' },
    });
    const paths = Object.keys(doc.paths ?? {});

    // Dot-free path with one URL param — emitted as `{userId}`.
    expect(paths.some(p => p === '/notes/get-by-user/{userId}')).toBe(true);

    // Pure-context path — actor.id is injected at runtime, no URL segment for it.
    expect(paths.some(p => p === '/notes/list-by-user')).toBe(true);

    // Mixed — tenantId in URL, actor.id injected.
    expect(paths.some(p => p === '/notes/list-by-tenant-and-actor/{tenantId}')).toBe(true);

    // No dotted segments anywhere — defense in depth.
    for (const p of paths) {
      expect(p).not.toMatch(/\{[^}]*\.[^}]*\}/);
    }
  });
});
