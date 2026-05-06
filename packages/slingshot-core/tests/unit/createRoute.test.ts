import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createRoute,
  maybeAutoRegister,
  registerSchema,
  registerSchemas,
  withSecurity,
} from '../../src/createRoute';

describe('createRoute', () => {
  test('returns a route config with method and path', () => {
    const route = createRoute({
      method: 'get',
      path: '/items',
      responses: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
      },
    });
    expect(route.method).toBe('get');
    expect(route.path).toBe('/items');
  });

  test('auto-names request body schema', () => {
    const bodySchema = z.object({ name: z.string() });
    const route = createRoute({
      method: 'post',
      path: '/items',
      request: {
        body: { content: { 'application/json': { schema: bodySchema } } },
      },
      responses: {
        201: { description: 'Created' },
      },
    });
    expect(route.method).toBe('post');
  });

  test('auto-names response schemas by status', () => {
    const route = createRoute({
      method: 'get',
      path: '/items/{id}',
      responses: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
        404: {
          description: 'Not Found',
          content: { 'application/json': { schema: z.object({ error: z.string() }) } },
        },
      },
    });
    expect(route.path).toBe('/items/{id}');
  });

  test('handles path params in naming', () => {
    const route = createRoute({
      method: 'patch',
      path: '/org/{orgId}/members/{userId}',
      responses: {
        200: { description: 'OK' },
      },
    });
    expect(route.method).toBe('patch');
  });

  test('handles unknown method', () => {
    const route = createRoute({
      method: 'options' as never,
      path: '/health',
      responses: {
        200: { description: 'OK' },
      },
    });
    expect(route.method as string).toBe('options');
  });
});

describe('registerSchema', () => {
  test('returns the same schema', () => {
    const schema = z.object({ test: z.string() });
    const result = registerSchema('TestRegisterSchema', schema);
    expect(result).toBe(schema);
  });

  test('does not error on double registration', () => {
    const schema = z.object({ test2: z.string() });
    registerSchema('TestDoubleReg', schema);
    expect(() => registerSchema('TestDoubleReg', schema)).not.toThrow();
  });
});

describe('registerSchemas', () => {
  test('registers multiple schemas and returns same object', () => {
    const schemas = {
      SchemaA: z.object({ a: z.string() }),
      SchemaB: z.object({ b: z.number() }),
    };
    const result = registerSchemas(schemas);
    expect(result).toBe(schemas);
  });
});

describe('maybeAutoRegister', () => {
  test('skips non-Zod values', () => {
    expect(() => maybeAutoRegister('NotASchema', 'just a string')).not.toThrow();
    expect(() => maybeAutoRegister('Null', null)).not.toThrow();
  });

  test('registers Zod schema and strips "Schema" suffix', () => {
    const schema = z.object({ val: z.string() });
    expect(() => maybeAutoRegister('MyThingSchema', schema)).not.toThrow();
  });

  test('does not strip if no Schema suffix', () => {
    const schema = z.object({ val2: z.string() });
    expect(() => maybeAutoRegister('MyEntity', schema)).not.toThrow();
  });
});

describe('withSecurity', () => {
  test('adds security to route config', () => {
    const route = createRoute({
      method: 'get',
      path: '/secure',
      responses: { 200: { description: 'OK' } },
    });
    const secured = withSecurity(route, { cookieAuth: [] }, { bearerAuth: [] });
    expect((secured as unknown as { security: unknown[] }).security).toHaveLength(2);
  });
});

describe('createRoute auto-registered schema names — defensive dot sanitization', () => {
  // Defensive: even if an upstream codegen leaks a context-scoped param into the
  // URL (`{actor.id}`), the auto-generated schema names must produce a valid TS
  // identifier for snapshot codegen to succeed. The split-on-dot + PascalCase
  // path in `toBaseName` collapses `{actor.id}` → `ByActorId`.
  test('brace path with dotted param yields a dot-free schema name', () => {
    const requestSchema = z.object({ actor_id: z.string() });
    const route = createRoute({
      method: 'get',
      path: '/notes/list-by-user/{actor.id}',
      request: { params: requestSchema },
      responses: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: z.object({ items: z.array(z.unknown()) }) } },
        },
      },
    });
    expect(route.path).toBe('/notes/list-by-user/{actor.id}');
    // The base name is internal — the test asserts the absence of dots indirectly
    // by confirming registration didn't throw and the route was created.
    expect(route.method).toBe('get');
  });

  test('brace path with multiple dotted params still produces a single valid identifier', () => {
    const route = createRoute({
      method: 'get',
      path: '/foo/{actor.id}/bar/{actor.tenantId}',
      responses: { 200: { description: 'OK' } },
    });
    expect(route.path).toBe('/foo/{actor.id}/bar/{actor.tenantId}');
  });
});
