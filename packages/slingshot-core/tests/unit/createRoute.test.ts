import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRoute, registerSchema, registerSchemas, maybeAutoRegister, withSecurity } from '../../src/createRoute';

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
    expect(route.method).toBe('options');
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
    expect((secured as { security: unknown[] }).security).toHaveLength(2);
  });
});
