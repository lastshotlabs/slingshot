import { describe, expect, it, mock, test } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { PageDeclaration, ResolvedPageDeclaration } from '../../src/pageDeclarations';
import {
  PageNotFoundError,
  resolvePageLoader,
  validatePageAdapters,
} from '../../src/pageLoaders';

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

describe('resolvePageLoader — entity pages with filters, forms, dashboards, and metadata', () => {
  function makeEntityConfig(
    name = 'post',
    fields: Record<string, unknown> = {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      slug: { type: 'string', optional: false, primary: false, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
      status: {
        type: 'string',
        optional: false,
        primary: false,
        immutable: false,
        enumValues: ['draft', 'published'],
      },
      views: { type: 'number', optional: false, primary: false, immutable: false },
      createdAt: { type: 'string', optional: false, primary: false, immutable: false },
    },
  ): ResolvedEntityConfig {
    return {
      name,
      namespace: name === 'post' ? 'content' : undefined,
      _pkField: 'id',
      fields,
      softDelete: name === 'post' ? { field: 'deletedAt' } : undefined,
    } as unknown as ResolvedEntityConfig;
  }

  const records = [
    {
      id: '1',
      slug: 'alpha',
      title: 'Alpha',
      status: 'draft',
      views: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '2',
      slug: 'beta',
      title: 'Beta',
      status: 'published',
      views: 20,
      createdAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: '3',
      slug: 'gamma',
      title: 'Gamma',
      status: 'published',
      views: 30,
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ];

  function makePagedAdapter(items = records) {
    return {
      getById: mock(async (id: string) => items.find(item => item.id === id) ?? null),
      bySlug: mock(async (params: Readonly<Record<string, string>>) =>
        items.find(item => item.slug === params.slug),
      ),
      list: mock(async ({ cursor }: { cursor?: string }) =>
        cursor
          ? { items: items.slice(2), hasMore: false }
          : { items: items.slice(0, 2), hasMore: true, nextCursor: 'next' },
      ),
    };
  }

  const entityConfigs = new Map([
    ['post', makeEntityConfig('post')],
    [
      'comment',
      makeEntityConfig('comment', {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        body: { type: 'string', optional: false, primary: false, immutable: false },
      }),
    ],
  ]);

  test('loads searchable, filtered, sorted, paginated entity lists with tags and metadata', async () => {
    const declaration = {
      key: 'posts',
      declaration: {
        type: 'entity-list',
        path: '/posts',
        title: 'Posts',
        entity: 'post',
        fields: ['title', 'status', 'views'],
        searchable: true,
        filters: [{ field: 'views', operator: 'gt' }],
        defaultSort: { field: 'views', order: 'asc' },
        pageSize: 1,
      },
      entityConfig: makeEntityConfig('post'),
      pattern: /^\/posts$/,
      paramNames: [],
    } as unknown as ResolvedPageDeclaration;

    const result = await resolvePageLoader(
      declaration,
      {},
      { q: 'a', filter_views: '10', page: '2' },
      { post: makePagedAdapter() },
      entityConfigs,
      { shell: 'sidebar', items: [{ label: 'Posts', path: '/posts' }] },
    );

    if (result.data.type !== 'list') throw new Error('unexpected type');
    expect(result.data.total).toBe(2);
    expect(result.data.items).toEqual([
      {
        id: '3',
        slug: 'gamma',
        title: 'Gamma',
        status: 'published',
        views: 30,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    expect(result.tags).toEqual(['entity:post']);
    expect(result.navigation?.shell).toBe('sidebar');
    expect(result.entityMeta.post?.namespace).toBe('content');
    expect(result.entityMeta.post?.fields.status.enumValues).toEqual(['draft', 'published']);
    expect(result.entityMeta.post?.softDelete).toEqual({ field: 'deletedAt' });
  });

  test('supports all entity-list filter operators', async () => {
    const cases: Array<{
      operator: 'contains' | 'lt' | 'gte' | 'lte' | 'in' | 'eq';
      field: string;
      value: string;
      expectedIds: string[];
    }> = [
      { operator: 'contains', field: 'title', value: 'mm', expectedIds: ['3'] },
      { operator: 'lt', field: 'views', value: '20', expectedIds: ['1'] },
      { operator: 'gte', field: 'views', value: '20', expectedIds: ['2', '3'] },
      { operator: 'lte', field: 'views', value: '20', expectedIds: ['1', '2'] },
      { operator: 'in', field: 'status', value: 'draft,published', expectedIds: ['1', '2', '3'] },
      { operator: 'eq', field: 'status', value: 'published', expectedIds: ['2', '3'] },
    ];

    for (const entry of cases) {
      const declaration = {
        key: `posts-${entry.operator}`,
        declaration: {
          type: 'entity-list',
          path: '/posts',
          title: 'Posts',
          entity: 'post',
          fields: ['title', 'status', 'views'],
          filters: [{ field: entry.field, operator: entry.operator }],
          defaultSort: { field: 'id', order: 'asc' },
        },
        entityConfig: makeEntityConfig('post'),
        pattern: /^\/posts$/,
        paramNames: [],
      } as unknown as ResolvedPageDeclaration;

      const result = await resolvePageLoader(
        declaration,
        {},
        { [`filter_${entry.field}`]: entry.value },
        { post: makePagedAdapter() },
        entityConfigs,
      );

      if (result.data.type !== 'list') throw new Error('unexpected type');
      expect(result.data.items.map(item => item.id)).toEqual(entry.expectedIds);
    }
  });

  test('loads detail pages through custom lookups with template titles and related metadata', async () => {
    const declaration = {
      key: 'post-detail',
      declaration: {
        type: 'entity-detail',
        path: '/posts/[slug]',
        title: { template: '{title} has {views} views' },
        entity: 'post',
        lookup: 'bySlug',
        related: [{ entity: 'comment' }],
        tags: ['post:{slug}'],
      },
      entityConfig: makeEntityConfig('post'),
      pattern: /^\/posts\/([^/]+)$/,
      paramNames: ['slug'],
    } as unknown as ResolvedPageDeclaration;

    const result = await resolvePageLoader(
      declaration,
      { slug: 'beta' },
      {},
      { post: makePagedAdapter() },
      entityConfigs,
    );

    if (result.data.type !== 'detail') throw new Error('unexpected type');
    expect(result.data.item.title).toBe('Beta');
    expect(result.meta.title).toBe('Beta has 20 views');
    expect(result.tags).toEqual(['post:beta']);
    expect(Object.keys(result.entityMeta).sort()).toEqual(['comment', 'post']);
  });

  test('loads create and edit form pages with defaults and entity record tags', async () => {
    const createDeclaration = {
      key: 'post-new',
      declaration: {
        type: 'entity-form',
        path: '/posts/new',
        title: 'New Post',
        entity: 'post',
        operation: 'create',
        fieldConfig: {
          status: { defaultValue: 'draft' },
          views: { defaultValue: 0 },
          title: {},
        },
        revalidate: 30,
      },
      entityConfig: makeEntityConfig('post'),
      pattern: /^\/posts\/new$/,
      paramNames: [],
    } as unknown as ResolvedPageDeclaration;
    const editDeclaration = {
      key: 'post-edit',
      declaration: {
        type: 'entity-form',
        path: '/posts/[id]/edit',
        title: { field: 'title' },
        entity: 'post',
        operation: 'edit',
      },
      entityConfig: makeEntityConfig('post'),
      pattern: /^\/posts\/([^/]+)\/edit$/,
      paramNames: ['id'],
    } as unknown as ResolvedPageDeclaration;

    const createResult = await resolvePageLoader(
      createDeclaration,
      {},
      {},
      { post: makePagedAdapter() },
      entityConfigs,
    );
    if (createResult.data.type !== 'form-create') throw new Error('unexpected type');
    expect(createResult.data.defaults).toEqual({ status: 'draft', views: 0 });
    expect(createResult.revalidate).toBe(30);

    const editResult = await resolvePageLoader(
      editDeclaration,
      { id: '1' },
      {},
      { post: makePagedAdapter() },
      entityConfigs,
    );
    if (editResult.data.type !== 'form-edit') throw new Error('unexpected type');
    expect(editResult.data.item.title).toBe('Alpha');
    expect(editResult.meta.title).toBe('Alpha');
    expect(editResult.tags).toEqual(['entity:post', 'entity:post:1']);
  });

  test('loads dashboard stats, activity, charts, and inferred tags', async () => {
    const declaration = {
      key: 'dashboard',
      declaration: {
        type: 'entity-dashboard',
        path: '/dashboard',
        title: 'Dashboard',
        stats: [
          {
            label: 'Published',
            entity: 'post',
            aggregate: 'count',
            filter: { status: 'published' },
          },
          { label: 'Total views', entity: 'post', aggregate: 'sum', field: 'views' },
          { label: 'Average views', entity: 'post', aggregate: 'avg', field: 'views' },
          { label: 'Minimum views', entity: 'post', aggregate: 'min', field: 'views' },
          { label: 'Maximum views', entity: 'post', aggregate: 'max', field: 'views' },
        ],
        activity: {
          entity: 'post',
          fields: ['title', 'createdAt'],
          limit: 2,
        },
        chart: {
          entity: 'post',
          categoryField: 'status',
          valueField: 'views',
          aggregate: 'avg',
        },
      },
      entityConfig: null,
      pattern: /^\/dashboard$/,
      paramNames: [],
    } as unknown as ResolvedPageDeclaration;

    const result = await resolvePageLoader(
      declaration,
      {},
      {},
      { post: makePagedAdapter() },
      entityConfigs,
    );

    if (result.data.type !== 'dashboard') throw new Error('unexpected type');
    expect(result.data.stats.map(stat => stat.value)).toEqual([2, 55, 55 / 3, 5, 30]);
    expect(result.data.activity?.map(item => item.title)).toEqual(['Beta', 'Gamma']);
    expect(result.data.chart).toEqual([
      { category: 'draft', value: 5 },
      { category: 'published', value: 25 },
    ]);
    expect(result.tags).toEqual(['entity:post']);
  });
});

// P-SSR-5 / P-SSR-6: dashboard stats use Promise.allSettled — one failed stat
// must NOT collapse the rest of the dashboard. Per-stat failures surface as
// `value: null` and a serialized `error` placeholder; successful stats render
// normally alongside the placeholder.
describe('resolvePageLoader — entity-dashboard stats failure isolation (P-SSR-5/6)', () => {
  function makeEntityConfig(name: string): ResolvedEntityConfig {
    return {
      name,
      _pkField: 'id',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        views: { type: 'number', optional: false, primary: false, immutable: false },
      },
    } as unknown as ResolvedEntityConfig;
  }

  function makeFlakyAdapter(opts: { fail?: boolean; items?: Record<string, unknown>[] } = {}) {
    return {
      getById: mock(async (_id: string) => null),
      list: mock(async () =>
        opts.fail
          ? Promise.reject(new Error('flaky adapter blew up'))
          : { items: opts.items ?? [], hasMore: false },
      ),
    };
  }

  test('renders successful stats and a serialized error placeholder for the failed one', async () => {
    const declaration = {
      key: 'dashboard',
      declaration: {
        type: 'entity-dashboard',
        path: '/dashboard',
        title: 'Dashboard',
        stats: [
          { label: 'Healthy', entity: 'good', aggregate: 'count' },
          { label: 'Flaky', entity: 'bad', aggregate: 'count' },
          { label: 'Also Healthy', entity: 'good', aggregate: 'sum', field: 'views' },
        ],
      },
      entityConfig: null,
      pattern: /^\/dashboard$/,
      paramNames: [],
    } as unknown as ResolvedPageDeclaration;

    const adapters = {
      good: makeFlakyAdapter({ items: [{ id: '1', views: 10 }, { id: '2', views: 20 }] }),
      bad: makeFlakyAdapter({ fail: true }),
    };
    const entityConfigs = new Map([
      ['good', makeEntityConfig('good')],
      ['bad', makeEntityConfig('bad')],
    ]);

    const result = await resolvePageLoader(declaration, {}, {}, adapters, entityConfigs);
    if (result.data.type !== 'dashboard') throw new Error('unexpected type');
    expect(result.data.stats).toHaveLength(3);
    expect(result.data.stats[0]).toMatchObject({ label: 'Healthy', value: 2 });
    expect(result.data.stats[1].label).toBe('Flaky');
    expect(result.data.stats[1].value).toBeNull();
    expect(result.data.stats[1].error).toBeDefined();
    expect(result.data.stats[1].error?.message).toContain('flaky adapter blew up');
    expect(result.data.stats[1].error?.name).toBe('Error');
    expect(result.data.stats[2]).toMatchObject({ label: 'Also Healthy', value: 30 });
  });

  test('a failing stat does not throw out of resolvePageLoader', async () => {
    const declaration = {
      key: 'dashboard',
      declaration: {
        type: 'entity-dashboard',
        path: '/dashboard',
        title: 'Dashboard',
        stats: [{ label: 'Flaky', entity: 'bad', aggregate: 'count' }],
      },
      entityConfig: null,
      pattern: /^\/dashboard$/,
      paramNames: [],
    } as unknown as ResolvedPageDeclaration;

    const adapters = { bad: makeFlakyAdapter({ fail: true }) };
    const entityConfigs = new Map([['bad', makeEntityConfig('bad')]]);
    const result = await resolvePageLoader(declaration, {}, {}, adapters, entityConfigs);
    if (result.data.type !== 'dashboard') throw new Error('unexpected type');
    expect(result.data.stats[0].value).toBeNull();
    expect(result.data.stats[0].error).toBeDefined();
  });
});

// P-SSR-3: validatePageAdapters() is called at plugin setup; fail with a
// descriptive message naming the offending page route when an adapter is
// missing for any referenced entity. Catches misconfiguration at boot rather
// than the first request.
describe('validatePageAdapters (P-SSR-3)', () => {
  function makeListPage(entity: string, route = '/list'): PageDeclaration {
    return {
      type: 'entity-list',
      path: route,
      title: 'List',
      entity,
      fields: ['id'],
    } as unknown as PageDeclaration;
  }

  test('returns silently when every referenced entity has an adapter', () => {
    const pages = { list: makeListPage('post') };
    const adapters = {
      post: { getById: async () => null, list: async () => ({ items: [], hasMore: false }) },
    };
    expect(() => validatePageAdapters(pages, adapters)).not.toThrow();
  });

  test('throws naming the page route when an adapter is missing', () => {
    const pages = { list: makeListPage('post', '/posts') };
    expect(() => validatePageAdapters(pages, {})).toThrow(/no adapter registered for entity "post"/);
    expect(() => validatePageAdapters(pages, {})).toThrow(/route \/posts/);
  });

  test('reports every missing adapter when multiple pages misconfigured', () => {
    const pages = {
      a: makeListPage('alpha', '/a'),
      b: makeListPage('beta', '/b'),
    };
    let captured: Error | undefined;
    try {
      validatePageAdapters(pages, {});
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured?.message).toContain('alpha');
    expect(captured?.message).toContain('beta');
    expect(captured?.message).toContain('/a');
    expect(captured?.message).toContain('/b');
  });

  test('walks dashboard stats / activity / chart entities', () => {
    const pages: Record<string, PageDeclaration> = {
      dash: {
        type: 'entity-dashboard',
        path: '/dash',
        title: 'Dash',
        stats: [{ label: 'A', entity: 'stat-entity', aggregate: 'count' }],
        activity: { entity: 'activity-entity', fields: ['id'] },
        chart: {
          entity: 'chart-entity',
          chartType: 'bar',
          categoryField: 'k',
          valueField: 'v',
          aggregate: 'sum',
        },
      } as unknown as PageDeclaration,
    };
    expect(() => validatePageAdapters(pages, {})).toThrow(/stat-entity/);
    expect(() => validatePageAdapters(pages, {})).toThrow(/activity-entity/);
    expect(() => validatePageAdapters(pages, {})).toThrow(/chart-entity/);
  });
});
