import { stripUnreferencedSchemas } from '@framework/lib/stripUnreferencedSchemas';
import { describe, expect, it } from 'bun:test';
import { createRoute } from '@lastshotlabs/slingshot-core';

interface SpecResult {
  components?: { schemas?: Record<string, unknown> };
  [key: string]: unknown;
}

function strip(spec: Record<string, unknown>): SpecResult {
  return stripUnreferencedSchemas(spec) as SpecResult;
}

// ---------------------------------------------------------------------------
// createRoute auto-naming
//
// The old version-prefix / token capture machinery (setVersionPrefix,
// clearVersionPrefix, getVersionToken, drainCapturedTokens,
// assertCapturedTokens) has been removed. createRoute now only handles
// auto-naming of unnamed request/response schemas.
// ---------------------------------------------------------------------------

describe('createRoute auto-naming', () => {
  it('returns a route config with the original path', () => {
    const route = createRoute({
      method: 'get',
      path: '/users',
      responses: { 200: { description: 'ok' } },
    });
    expect(route.path).toBe('/users');
  });

  it('preserves method and responses on the returned config', () => {
    const route = createRoute({
      method: 'post',
      path: '/items',
      responses: {
        201: { description: 'created' },
        400: { description: 'bad request' },
      },
    });
    expect(route.method).toBe('post');
    expect(route.responses['201']).toBeDefined();
    expect(route.responses['400']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stripUnreferencedSchemas
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas', () => {
  it('returns spec unchanged when no components.schemas present', () => {
    const spec = { openapi: '3.0.0', info: { title: 'Test', version: '1' }, paths: {} };
    expect(stripUnreferencedSchemas(spec)).toEqual(spec);
  });

  it('removes schemas not referenced by any path', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/users': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string' } } },
          Phantom: { type: 'object', properties: { x: { type: 'number' } } },
        },
      },
    };
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('User');
    expect(result.components!.schemas).not.toHaveProperty('Phantom');
  });

  it('keeps transitively referenced schemas', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/items': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/ItemList' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ItemList: {
            type: 'array',
            items: { $ref: '#/components/schemas/Item' },
          },
          Item: { type: 'object', properties: { id: { type: 'string' } } },
          Phantom: { type: 'string' },
        },
      },
    };
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('ItemList');
    expect(result.components!.schemas).toHaveProperty('Item');
    expect(result.components!.schemas).not.toHaveProperty('Phantom');
  });

  it('is a no-op when all schemas are referenced', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Req' } } },
            },
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Res' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Req: { type: 'object' },
          Res: { type: 'object' },
        },
      },
    };
    const result = strip(spec);
    expect(Object.keys(result.components!.schemas!)).toEqual(['Req', 'Res']);
  });

  it('removes components.schemas when nothing is referenced', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } },
      components: {
        schemas: {
          Orphan: { type: 'string' },
        },
      },
    };
    const result = strip(spec);
    expect(result.components?.schemas).toBeUndefined();
  });

  it('does not mutate the original spec', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {},
      components: { schemas: { Orphan: { type: 'string' } } },
    };
    const copy = JSON.parse(JSON.stringify(spec));
    stripUnreferencedSchemas(spec);
    expect(spec).toEqual(copy);
  });
});
