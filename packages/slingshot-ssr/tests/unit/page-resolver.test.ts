import { describe, expect, it } from 'bun:test';
import { buildPageRouteTable, resolvePageDeclaration } from '../../src/pageResolver';
import type { PageDeclaration } from '../../src/pageDeclarations';

// Helper to create a minimal custom page declaration
function customPage(path: string): PageDeclaration {
  return {
    type: 'custom',
    path,
    title: path,
    handler: { handler: 'noop' },
  };
}

const emptyEntityConfigs = new Map();

// ---------------------------------------------------------------------------
// buildPageRouteTable
// ---------------------------------------------------------------------------

describe('buildPageRouteTable', () => {
  it('returns an empty table for an empty pages map', () => {
    const table = buildPageRouteTable({}, emptyEntityConfigs);
    expect(table).toHaveLength(0);
  });

  it('static routes sort before dynamic routes', () => {
    const table = buildPageRouteTable(
      {
        dynamic: customPage('/[id]'),
        about: customPage('/about'),
      },
      emptyEntityConfigs,
    );

    expect(table[0].declaration.path).toBe('/about');
    expect(table[1].declaration.path).toBe('/[id]');
  });

  it('more specific routes sort before less specific routes', () => {
    const table = buildPageRouteTable(
      {
        postById: customPage('/posts/[id]'),
        newPost: customPage('/posts/new'),
      },
      emptyEntityConfigs,
    );

    expect(table[0].declaration.path).toBe('/posts/new');
    expect(table[1].declaration.path).toBe('/posts/[id]');
  });

  it('catch-all routes sort last', () => {
    const table = buildPageRouteTable(
      {
        catchAll: customPage('/docs/[...slug]'),
        docById: customPage('/docs/[id]'),
        docList: customPage('/docs'),
      },
      emptyEntityConfigs,
    );

    // The catch-all must be the last entry
    expect(table[table.length - 1].declaration.path).toBe('/docs/[...slug]');
    // Static route must come before dynamic
    expect(table[0].declaration.path).toBe('/docs');
  });

  it('extracts correct paramNames for /posts/[id]', () => {
    const table = buildPageRouteTable(
      { postById: customPage('/posts/[id]') },
      emptyEntityConfigs,
    );

    expect(table).toHaveLength(1);
    expect(Array.from(table[0].paramNames)).toEqual(['id']);
  });

  it('extracts correct paramNames for catch-all route', () => {
    const table = buildPageRouteTable(
      { docs: customPage('/docs/[...slug]') },
      emptyEntityConfigs,
    );

    expect(Array.from(table[0].paramNames)).toEqual(['slug']);
  });
});

// ---------------------------------------------------------------------------
// resolvePageDeclaration
// ---------------------------------------------------------------------------

describe('resolvePageDeclaration', () => {
  it('matches an exact static route', () => {
    const table = buildPageRouteTable(
      { about: customPage('/about') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/about', table);
    expect(result).not.toBeNull();
    expect(result!.declaration.declaration.path).toBe('/about');
    expect(result!.params).toEqual({});
  });

  it('matches a dynamic route and extracts params', () => {
    const table = buildPageRouteTable(
      { postById: customPage('/posts/[id]') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/posts/123', table);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '123' });
  });

  it('matches a catch-all route and extracts the rest segment', () => {
    const table = buildPageRouteTable(
      { docs: customPage('/docs/[...slug]') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/docs/a/b/c', table);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ slug: 'a/b/c' });
  });

  it('returns null for an unknown path', () => {
    const table = buildPageRouteTable(
      { about: customPage('/about') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/does-not-exist', table);
    expect(result).toBeNull();
  });

  it('static route wins over dynamic when both could match', () => {
    const table = buildPageRouteTable(
      {
        newPost: customPage('/posts/new'),
        postById: customPage('/posts/[id]'),
      },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/posts/new', table);
    expect(result).not.toBeNull();
    expect(result!.declaration.declaration.path).toBe('/posts/new');
  });

  it('URL-decodes extracted param values', () => {
    const table = buildPageRouteTable(
      { postById: customPage('/posts/[id]') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/posts/hello%20world', table);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: 'hello world' });
  });

  it('strips trailing slash before matching', () => {
    const table = buildPageRouteTable(
      { about: customPage('/about') },
      emptyEntityConfigs,
    );

    const result = resolvePageDeclaration('/about/', table);
    expect(result).not.toBeNull();
    expect(result!.declaration.declaration.path).toBe('/about');
  });
});
