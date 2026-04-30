import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineHandler } from '../../src/handler';
import { toRoute } from '../../src/mount';

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
    // Route was created without throwing — params were accepted
    expect(route.path).toBe('/items/:id');
  });
});
