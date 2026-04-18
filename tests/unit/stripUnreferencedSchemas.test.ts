/**
 * Unit tests for stripUnreferencedSchemas.
 *
 * Verifies BFS traversal removes truly phantom schemas while retaining
 * directly and transitively referenced ones. No infrastructure required.
 */
import { describe, expect, test } from 'bun:test';
import { stripUnreferencedSchemas } from '../../src/framework/lib/stripUnreferencedSchemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpecResult {
  components?: { schemas?: Record<string, unknown>; securitySchemes?: unknown };
  [key: string]: unknown;
}

function strip(spec: Record<string, unknown>): SpecResult {
  return stripUnreferencedSchemas(spec) as SpecResult;
}

function makeSpec(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1' },
    paths: {},
    components: { schemas: {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard: no-op when nothing to strip
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas — guard clauses', () => {
  test('returns spec unchanged when components.schemas is absent', () => {
    const spec = { openapi: '3.1.0', paths: {} };
    const result = strip(spec);
    expect(result).toBe(spec); // exact same reference
  });

  test('returns spec unchanged when components.schemas is null', () => {
    const spec = makeSpec({ components: { schemas: null } });
    const result = strip(spec);
    expect(result).toBe(spec);
  });

  test('returns spec unchanged when components is absent', () => {
    const spec = { openapi: '3.1.0', paths: {} };
    expect(stripUnreferencedSchemas(spec)).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// Basic stripping
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas — basic stripping', () => {
  test('removes all schemas when paths is empty', () => {
    const spec = makeSpec({
      paths: {},
      components: { schemas: { Unused: { type: 'object' } } },
    });
    const result = strip(spec);
    expect(result.components).toBeUndefined();
  });

  test('preserves schema directly $ref-ed from a path operation', () => {
    const spec = makeSpec({
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
          Phantom: { type: 'object' },
        },
      },
    });
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('User');
    expect(result.components!.schemas).not.toHaveProperty('Phantom');
  });

  test('removes schema not referenced by any path', () => {
    const spec = makeSpec({
      paths: {
        '/ping': { get: { responses: { 200: { description: 'ok' } } } },
      },
      components: {
        schemas: { NeverUsed: { type: 'string' } },
      },
    });
    const result = strip(spec);
    expect(result.components).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transitive references
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas — transitive references', () => {
  test('transitively preserves schema referenced only from another schema', () => {
    // Path → A → B  (B is only reachable via A)
    const spec = makeSpec({
      paths: {
        '/items': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: {
            type: 'object',
            properties: { nested: { $ref: '#/components/schemas/B' } },
          },
          B: { type: 'object', properties: { val: { type: 'number' } } },
          Orphan: { type: 'string' },
        },
      },
    });
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('A');
    expect(result.components!.schemas).toHaveProperty('B');
    expect(result.components!.schemas).not.toHaveProperty('Orphan');
  });

  test('handles deep transitive chain (A → B → C → D)', () => {
    const spec = makeSpec({
      paths: {
        '/': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/C' },
          C: { $ref: '#/components/schemas/D' },
          D: { type: 'string' },
          Orphan: { type: 'number' },
        },
      },
    });
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('A');
    expect(result.components!.schemas).toHaveProperty('B');
    expect(result.components!.schemas).toHaveProperty('C');
    expect(result.components!.schemas).toHaveProperty('D');
    expect(result.components!.schemas).not.toHaveProperty('Orphan');
  });

  test('handles $ref inside allOf/oneOf/anyOf arrays', () => {
    const spec = makeSpec({
      paths: {
        '/': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/Cat' },
                      { $ref: '#/components/schemas/Dog' },
                    ],
                  },
                },
              },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: {
          Cat: { type: 'object', properties: { meow: { type: 'boolean' } } },
          Dog: { type: 'object', properties: { bark: { type: 'boolean' } } },
          Fish: { type: 'object' }, // not referenced
        },
      },
    });
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('Cat');
    expect(result.components!.schemas).toHaveProperty('Dog');
    expect(result.components!.schemas).not.toHaveProperty('Fish');
  });

  test('does not infinite-loop on circular schema references', () => {
    // A → B → A  (circular)
    const spec = makeSpec({
      paths: {
        '/': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { properties: { child: { $ref: '#/components/schemas/B' } } },
          B: { properties: { parent: { $ref: '#/components/schemas/A' } } },
        },
      },
    });
    // Should not throw or hang
    const result = strip(spec);
    expect(result.components!.schemas).toHaveProperty('A');
    expect(result.components!.schemas).toHaveProperty('B');
  });
});

// ---------------------------------------------------------------------------
// Immutability: original spec is not mutated
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas — original spec not mutated', () => {
  test('returns a shallow clone; original components.schemas is unchanged', () => {
    const originalSchemas = {
      Used: { type: 'object' },
      Orphan: { type: 'string' },
    };
    const spec = makeSpec({
      paths: {
        '/': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } },
              },
            },
          },
        },
      },
      components: { schemas: originalSchemas },
    });
    stripUnreferencedSchemas(spec);
    // Original must still have both schemas
    expect(originalSchemas).toHaveProperty('Used');
    expect(originalSchemas).toHaveProperty('Orphan');
  });

  test('result is a different object reference from spec', () => {
    const spec = makeSpec({
      paths: {
        '/': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Foo' } } },
              },
            },
          },
        },
      },
      components: { schemas: { Foo: { type: 'object' }, Bar: { type: 'string' } } },
    });
    const result = strip(spec);
    expect(result).not.toBe(spec);
    expect(result.components).not.toBe(spec.components);
  });
});

// ---------------------------------------------------------------------------
// Component cleanup
// ---------------------------------------------------------------------------

describe('stripUnreferencedSchemas — component cleanup', () => {
  test('deletes entire components object when no schemas remain and no other sections exist', () => {
    const spec = makeSpec({
      paths: {},
      components: { schemas: { Orphan: { type: 'object' } } },
    });
    const result = strip(spec);
    expect(result.components).toBeUndefined();
  });

  test('preserves other component sections (e.g. securitySchemes) alongside stripped schemas', () => {
    const spec = makeSpec({
      paths: {},
      components: {
        schemas: { Orphan: { type: 'object' } },
        securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    });
    const result = strip(spec);
    expect(result.components).toBeDefined();
    expect(result.components!.securitySchemes).toBeDefined();
    expect(result.components!.schemas).toBeUndefined();
  });

  test('multiple paths referencing the same schema keep it once', () => {
    const spec = makeSpec({
      paths: {
        '/a': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Shared' } },
                },
              },
            },
          },
        },
        '/b': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Shared' } } },
            },
            responses: { 201: { description: 'ok' } },
          },
        },
      },
      components: { schemas: { Shared: { type: 'object' } } },
    });
    const result = strip(spec);
    expect(Object.keys(result.components!.schemas!)).toHaveLength(1);
    expect(result.components!.schemas).toHaveProperty('Shared');
  });

  test('non-spec $ref values (external URLs) are ignored', () => {
    const spec = makeSpec({
      paths: {
        '/': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { $ref: 'https://external.example.com/schemas/Thing' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Local: { type: 'object' },
        },
      },
    });
    const result = strip(spec);
    // External $refs don't match #/components/schemas/ prefix — local schemas are removed
    expect(result.components).toBeUndefined();
  });
});
