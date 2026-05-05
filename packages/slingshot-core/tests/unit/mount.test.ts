import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineHandler } from '../../src/handler';
import { toOpenApiPath, toRoute } from '../../src/mount';

describe('toRoute', () => {
  const handler = defineHandler({
    name: 'testHandler',
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    handle: () => ({ id: 'abc' }),
  });

  test('creates a GET route with query input', () => {
    const route = toRoute(handler, { method: 'get', path: '/items' });
    expect(route.method).toBe('get');
    expect(route.path).toBe('/items');
  });

  test('creates a POST route with body input and 201 default status', () => {
    const route = toRoute(handler, { method: 'post', path: '/items' });
    expect(route.method).toBe('post');
    expect(route.path).toBe('/items');
    expect(route.responses).toHaveProperty('201');
  });

  test('GET route uses 200 default status', () => {
    const route = toRoute(handler, { method: 'get', path: '/items' });
    expect(route.responses).toHaveProperty('200');
  });

  test('custom successStatus overrides default', () => {
    const route = toRoute(handler, { method: 'post', path: '/items', successStatus: 200 });
    expect(route.responses).toHaveProperty('200');
    expect(route.responses).not.toHaveProperty('201');
  });

  test('includes tags and summary', () => {
    const route = toRoute(handler, {
      method: 'get',
      path: '/items',
      tags: ['items'],
      summary: 'Get all items',
    });
    expect(route.tags).toEqual(['items']);
    expect(route.summary).toBe('Get all items');
  });

  test('uses handler name as default summary', () => {
    const route = toRoute(handler, { method: 'get', path: '/items' });
    expect(route.summary).toBe('testHandler');
  });

  test('includes standard error responses', () => {
    const route = toRoute(handler, { method: 'get', path: '/items' });
    expect(route.responses).toHaveProperty('400');
    expect(route.responses).toHaveProperty('401');
    expect(route.responses).toHaveProperty('403');
    expect(route.responses).toHaveProperty('404');
    expect(route.responses).toHaveProperty('409');
    expect(route.responses).toHaveProperty('429');
    expect(route.responses).toHaveProperty('500');
  });

  test('PUT method uses body input', () => {
    const route = toRoute(handler, { method: 'put', path: '/items/:id' });
    expect(route.method).toBe('put');
  });

  test('PATCH method uses body input', () => {
    const route = toRoute(handler, { method: 'patch', path: '/items/:id' });
    expect(route.method).toBe('patch');
  });

  test('DELETE method uses query input', () => {
    const route = toRoute(handler, { method: 'delete', path: '/items/:id' });
    expect(route.method).toBe('delete');
  });

  test('includes params when provided', () => {
    const params = z.object({ id: z.string() });
    const route = toRoute(handler, {
      method: 'get',
      path: '/items/:id',
      params,
    });
    expect(route.method).toBe('get');
    // Hono colon form is converted to OpenAPI brace form on the route definition
    // (the live router is wired separately with the original colon form).
    expect(route.path).toBe('/items/{id}');
  });
});

describe('toOpenApiPath', () => {
  test('converts a single hono param to OpenAPI brace form', () => {
    expect(toOpenApiPath('/posts/:id')).toBe('/posts/{id}');
  });

  test('converts multiple hono params', () => {
    expect(toOpenApiPath('/orgs/:orgId/users/:userId')).toBe('/orgs/{orgId}/users/{userId}');
  });

  test('leaves already-converted brace segments alone (idempotent)', () => {
    expect(toOpenApiPath('/posts/{id}')).toBe('/posts/{id}');
    expect(toOpenApiPath(toOpenApiPath('/posts/:id'))).toBe('/posts/{id}');
  });

  test('strips hono optional marker (`:id?` becomes `{id}`)', () => {
    expect(toOpenApiPath('/posts/:id?')).toBe('/posts/{id}');
  });

  test('strips hono regex constraint (`:slug{.+}` becomes `{slug}`)', () => {
    expect(toOpenApiPath('/posts/:slug{.+}')).toBe('/posts/{slug}');
    expect(toOpenApiPath('/posts/:id{[0-9]+}')).toBe('/posts/{id}');
  });

  test('mixes literal segments and params correctly', () => {
    expect(toOpenApiPath('/api/v1/matches/:id/start')).toBe('/api/v1/matches/{id}/start');
  });

  test('returns root path unchanged', () => {
    expect(toOpenApiPath('/')).toBe('/');
  });
});
