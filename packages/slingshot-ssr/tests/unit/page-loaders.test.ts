import { describe, expect, it, mock } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { ResolvedPageDeclaration } from '../../src/pageDeclarations';
import { PageNotFoundError, resolvePageLoader } from '../../src/pageLoaders';

function makeCustomDeclaration(
  overrides: Partial<{
    title: string;
    revalidate: number;
    tags: readonly string[];
  }> = {},
): ResolvedPageDeclaration {
  return {
    key: 'custom-page',
    declaration: {
      type: 'custom',
      path: '/custom',
      title: overrides.title ?? 'Custom Page',
      handler: { handler: 'noop' },
      ...(overrides.revalidate !== undefined ? { revalidate: overrides.revalidate } : {}),
      ...(overrides.tags ? { tags: overrides.tags } : {}),
    },
    entityConfig: null,
    pattern: /^\/custom$/,
    paramNames: [],
  };
}

describe('PageNotFoundError', () => {
  it('is an instance of Error', () => {
    const err = new PageNotFoundError('Post', { id: '42' });
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "PageNotFoundError"', () => {
    const err = new PageNotFoundError('Post', { id: '42' });
    expect(err.name).toBe('PageNotFoundError');
  });

  it('exposes the entity name', () => {
    const err = new PageNotFoundError('User', { slug: 'jdoe' });
    expect(err.entity).toBe('User');
  });

  it('exposes the params', () => {
    const params = { id: '99' };
    const err = new PageNotFoundError('Order', params);
    expect(err.params).toEqual(params);
  });

  it('includes entity name and params JSON in the message', () => {
    const err = new PageNotFoundError('Post', { id: '7' });
    expect(err.message).toContain('Post');
    expect(err.message).toContain('"id"');
    expect(err.message).toContain('"7"');
  });
});

describe('resolvePageLoader — custom declaration', () => {
  it('returns data.type "custom"', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.data.type).toBe('custom');
  });

  it('passes the declaration through', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.declaration).toBe(decl);
  });

  it('resolves a string title', async () => {
    const decl = makeCustomDeclaration({ title: 'Hello World' });
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.meta.title).toBe('Hello World');
  });

  it('returns an empty frozen entityMeta', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.entityMeta).toEqual({});
  });

  it('omits navigation when not provided', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect('navigation' in result).toBe(false);
  });

  it('passes navigation through when provided', async () => {
    const decl = makeCustomDeclaration();
    const nav = { shell: 'sidebar' as const, items: [] };
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map(), nav);
    expect(result.navigation).toBe(nav);
  });

  it('omits revalidate when declaration has none', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect('revalidate' in result).toBe(false);
  });

  it('passes revalidate through when set on declaration', async () => {
    const decl = makeCustomDeclaration({ revalidate: 60 });
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.revalidate).toBe(60);
  });

  it('omits tags when declaration has none', async () => {
    const decl = makeCustomDeclaration();
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect('tags' in result).toBe(false);
  });

  it('passes tags through when set on declaration', async () => {
    const decl = makeCustomDeclaration({ tags: ['home', 'featured'] });
    const result = await resolvePageLoader(decl, {}, {}, {}, new Map());
    expect(result.tags).toEqual(['home', 'featured']);
  });
});

describe('resolvePageLoader — entity-list', () => {
  function makeEntityConfig(): ResolvedEntityConfig {
    return {
      name: 'post',
      _pkField: 'id',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
      },
    } as unknown as ResolvedEntityConfig;
  }

  function makeListDeclaration(): ResolvedPageDeclaration {
    return {
      key: 'posts',
      declaration: {
        type: 'entity-list',
        path: '/posts',
        title: 'Posts',
        entity: 'post',
        fields: ['id', 'title'],
      },
      entityConfig: makeEntityConfig(),
      pattern: /^\/posts$/,
      paramNames: [],
    };
  }

  function makeAdapter(items: Record<string, unknown>[] = []) {
    return {
      post: {
        getById: mock(async (_id: string) => null),
        list: mock(async () => ({ items, hasMore: false })),
      },
    };
  }

  it('returns data.type "list"', async () => {
    const decl = makeListDeclaration();
    const result = await resolvePageLoader(
      decl,
      {},
      {},
      makeAdapter(),
      new Map([['post', makeEntityConfig()]]),
    );
    expect(result.data.type).toBe('list');
  });

  it('returns empty items when adapter returns no records', async () => {
    const decl = makeListDeclaration();
    const result = await resolvePageLoader(
      decl,
      {},
      {},
      makeAdapter([]),
      new Map([['post', makeEntityConfig()]]),
    );
    if (result.data.type !== 'list') throw new Error('unexpected type');
    expect(result.data.items).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });

  it('returns loaded items', async () => {
    const decl = makeListDeclaration();
    const records = [
      { id: '1', title: 'Alpha' },
      { id: '2', title: 'Beta' },
    ];
    const result = await resolvePageLoader(
      decl,
      {},
      {},
      makeAdapter(records),
      new Map([['post', makeEntityConfig()]]),
    );
    if (result.data.type !== 'list') throw new Error('unexpected type');
    expect(result.data.total).toBe(2);
  });

  it('throws when the adapter is missing', async () => {
    const decl = makeListDeclaration();
    await expect(
      resolvePageLoader(decl, {}, {}, {}, new Map([['post', makeEntityConfig()]])),
    ).rejects.toThrow('post');
  });

  it('throws when the entity config is missing', async () => {
    const decl = makeListDeclaration();
    await expect(resolvePageLoader(decl, {}, {}, makeAdapter(), new Map())).rejects.toThrow('post');
  });
});

describe('resolvePageLoader — entity-detail', () => {
  function makeEntityConfig(): ResolvedEntityConfig {
    return {
      name: 'post',
      _pkField: 'id',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
      },
    } as unknown as ResolvedEntityConfig;
  }

  function makeDetailDeclaration(): ResolvedPageDeclaration {
    return {
      key: 'post-detail',
      declaration: {
        type: 'entity-detail',
        path: '/posts/[id]',
        title: { field: 'title' },
        entity: 'post',
      },
      entityConfig: makeEntityConfig(),
      pattern: /^\/posts\/([^/]+)$/,
      paramNames: ['id'],
    };
  }

  it('returns data.type "detail" when the record is found', async () => {
    const decl = makeDetailDeclaration();
    const adapters = {
      post: {
        getById: mock(async () => ({ id: '1', title: 'Hello' })),
        list: mock(async () => ({ items: [], hasMore: false })),
      },
    };
    const result = await resolvePageLoader(
      decl,
      { id: '1' },
      {},
      adapters,
      new Map([['post', makeEntityConfig()]]),
    );
    expect(result.data.type).toBe('detail');
  });

  it('resolves title from field value', async () => {
    const decl = makeDetailDeclaration();
    const adapters = {
      post: {
        getById: mock(async () => ({ id: '1', title: 'My Post' })),
        list: mock(async () => ({ items: [], hasMore: false })),
      },
    };
    const result = await resolvePageLoader(
      decl,
      { id: '1' },
      {},
      adapters,
      new Map([['post', makeEntityConfig()]]),
    );
    expect(result.meta.title).toBe('My Post');
  });

  it('throws PageNotFoundError when the record is not found', async () => {
    const decl = makeDetailDeclaration();
    const adapters = {
      post: {
        getById: mock(async () => null),
        list: mock(async () => ({ items: [], hasMore: false })),
      },
    };
    await expect(
      resolvePageLoader(decl, { id: '999' }, {}, adapters, new Map([['post', makeEntityConfig()]])),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });
});
