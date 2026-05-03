import { describe, expect, test } from 'bun:test';
import type { OperationConfig } from '@lastshotlabs/slingshot-core';
import { resolveNamedOperationRoute } from '../../src/routing/namedOperationRouting';

describe('resolveNamedOperationRoute', () => {
  test('defaults lookup operations to GET with param segments', () => {
    const opConfig: OperationConfig = {
      kind: 'lookup',
      returns: 'one',
      fields: { slug: 'param:slug' },
    };
    const result = resolveNamedOperationRoute('bySlug', opConfig);
    expect(result.method).toBe('get');
    expect(result.path).toContain(':slug');
  });

  test('defaults exists operations to HEAD with param segments', () => {
    const opConfig: OperationConfig = {
      kind: 'exists',
      fields: { email: 'param:email' },
    };
    const result = resolveNamedOperationRoute('byEmail', opConfig);
    expect(result.method).toBe('head');
    expect(result.path).toContain(':email');
  });

  test('defaults transition operations to POST with plain path', () => {
    const opConfig: OperationConfig = {
      kind: 'transition',
      from: 'draft',
      to: 'published',
      match: { id: 'id' },
    };
    const result = resolveNamedOperationRoute('publish', opConfig);
    expect(result.method).toBe('post');
    expect(result.path).toBe('publish');
  });

  test('defaults action/custom operations to POST', () => {
    const opConfig: OperationConfig = {
      kind: 'custom',
    };
    const result = resolveNamedOperationRoute('doSomething', opConfig);
    expect(result.method).toBe('post');
    expect(result.path).toBe('do-something');
  });

  test('defaults to POST with base path when opConfig is undefined', () => {
    const result = resolveNamedOperationRoute('syncAll', undefined);
    expect(result.method).toBe('post');
    expect(result.path).toBe('sync-all');
  });

  test('overrides take highest priority over everything', () => {
    const opConfig: OperationConfig = {
      kind: 'lookup',
      returns: 'one',
      fields: { slug: 'slug' },
    };
    const result = resolveNamedOperationRoute('bySlug', opConfig, {
      method: 'post',
      path: 'custom-path',
    });
    expect(result.method).toBe('post');
    expect(result.path).toBe('custom-path');
  });

  test('custom kind http config takes priority over defaults', () => {
    const opConfig: OperationConfig = {
      kind: 'custom',
      http: { method: 'put', path: 'my-custom' },
    };
    const result = resolveNamedOperationRoute('doThing', opConfig);
    expect(result.method).toBe('put');
    expect(result.path).toBe('my-custom');
  });

  test('overrides beat custom http config', () => {
    const opConfig: OperationConfig = {
      kind: 'custom',
      http: { method: 'put', path: 'custom-path' },
    };
    const result = resolveNamedOperationRoute('doThing', opConfig, {
      method: 'delete',
      path: 'override-path',
    });
    expect(result.method).toBe('delete');
    expect(result.path).toBe('override-path');
  });

  test('partial overrides merge with defaults', () => {
    const opConfig: OperationConfig = {
      kind: 'lookup',
      returns: 'one',
      fields: { slug: 'param:slug' },
    };
    const result = resolveNamedOperationRoute('bySlug', opConfig, {
      method: 'post',
    });
    expect(result.method).toBe('post');
    expect(result.path).toContain(':slug');
  });

  test('lookup with no params produces path without param segments', () => {
    const opConfig: OperationConfig = {
      kind: 'lookup',
      returns: 'many',
      fields: {},
    };
    const result = resolveNamedOperationRoute('listActive', opConfig);
    expect(result.method).toBe('get');
    expect(result.path).toBe('list-active');
  });

  test('deduplicates params in path segments', () => {
    const opConfig: OperationConfig = {
      kind: 'lookup',
      returns: 'one',
      fields: { id: 'param:id', id2: 'param:id' },
    };
    const result = resolveNamedOperationRoute('byId', opConfig);
    const paramSegments = result.path.split('/').filter(s => s.startsWith(':'));
    const paramNames = paramSegments.map(s => s.slice(1));
    expect(new Set(paramNames).size).toBe(paramNames.length);
  });
});
