import { describe, expect, it, mock } from 'bun:test';
import type { ResolvedPageDeclaration } from '../../src/pageDeclarations';
import { generatePageStaticParams } from '../../src/static-params/pageStaticParams';

function listDeclaration(paramNames: string[] = []): ResolvedPageDeclaration {
  return {
    key: 'posts',
    declaration: {
      type: 'entity-list',
      path: '/posts',
      title: 'Posts',
      entity: 'post',
      fields: ['id', 'title'],
    },
    entityConfig: null,
    pattern: /^\/posts$/,
    paramNames,
  };
}

function dashboardDeclaration(paramNames: string[] = []): ResolvedPageDeclaration {
  return {
    key: 'dashboard',
    declaration: {
      type: 'entity-dashboard',
      path: '/dashboard',
      title: 'Dashboard',
      stats: [{ entity: 'post', aggregate: 'count', label: 'Posts' }],
    },
    entityConfig: null,
    pattern: /^\/dashboard$/,
    paramNames,
  };
}

function detailDeclaration(paramNames: string[] = ['id']): ResolvedPageDeclaration {
  return {
    key: 'post-detail',
    declaration: {
      type: 'entity-detail',
      path: '/posts/[id]',
      title: { field: 'title' },
      entity: 'post',
    },
    entityConfig: null,
    pattern: /^\/posts\/([^/]+)$/,
    paramNames,
  };
}

function createFormDeclaration(paramNames: string[] = []): ResolvedPageDeclaration {
  return {
    key: 'post-create',
    declaration: {
      type: 'entity-form',
      path: '/posts/new',
      title: 'New Post',
      entity: 'post',
      operation: 'create',
      fields: ['title'],
    },
    entityConfig: null,
    pattern: /^\/posts\/new$/,
    paramNames,
  };
}

function editFormDeclaration(paramNames: string[] = ['id']): ResolvedPageDeclaration {
  return {
    key: 'post-edit',
    declaration: {
      type: 'entity-form',
      path: '/posts/[id]/edit',
      title: 'Edit Post',
      entity: 'post',
      operation: 'update',
      fields: ['title'],
    },
    entityConfig: null,
    pattern: /^\/posts\/([^/]+)\/edit$/,
    paramNames,
  };
}

function customDeclaration(): ResolvedPageDeclaration {
  return {
    key: 'custom',
    declaration: {
      type: 'custom',
      path: '/custom',
      title: 'Custom',
      handler: { handler: 'noop' },
    },
    entityConfig: null,
    pattern: /^\/custom$/,
    paramNames: [],
  };
}

function makeAdapter(items: Record<string, unknown>[] = []) {
  return {
    post: {
      list: mock(async () => ({ items, hasMore: false })),
    },
  };
}

describe('generatePageStaticParams — entity-list', () => {
  it('returns [{}] when the path has no dynamic segments', async () => {
    const result = await generatePageStaticParams(listDeclaration([]), makeAdapter());
    expect(result).toEqual([{}]);
  });

  it('returns [] when the path has dynamic segments', async () => {
    const result = await generatePageStaticParams(listDeclaration(['tenant']), makeAdapter());
    expect(result).toEqual([]);
  });
});

describe('generatePageStaticParams — entity-dashboard', () => {
  it('returns [{}] when the path has no dynamic segments', async () => {
    const result = await generatePageStaticParams(dashboardDeclaration([]), makeAdapter());
    expect(result).toEqual([{}]);
  });

  it('returns [] when the path has dynamic segments', async () => {
    const result = await generatePageStaticParams(dashboardDeclaration(['org']), makeAdapter());
    expect(result).toEqual([]);
  });
});

describe('generatePageStaticParams — entity-detail', () => {
  it('enumerates one param set per record', async () => {
    const records = [
      { id: '1', title: 'Alpha' },
      { id: '2', title: 'Beta' },
    ];
    const result = await generatePageStaticParams(detailDeclaration(['id']), makeAdapter(records));
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('returns [] when the adapter has no records', async () => {
    const result = await generatePageStaticParams(detailDeclaration(['id']), makeAdapter([]));
    expect(result).toEqual([]);
  });

  it('returns [] when the adapter is not registered', async () => {
    const result = await generatePageStaticParams(detailDeclaration(['id']), {});
    expect(result).toEqual([]);
  });

  it('skips records that are missing a required param field', async () => {
    const records = [{ id: '1' }, { title: 'no-id' }];
    const result = await generatePageStaticParams(detailDeclaration(['id']), makeAdapter(records));
    expect(result).toEqual([{ id: '1' }]);
  });

  it('converts numeric id values to strings', async () => {
    const records = [{ id: 42 }];
    const result = await generatePageStaticParams(detailDeclaration(['id']), makeAdapter(records));
    expect(result).toEqual([{ id: '42' }]);
  });

  it('converts boolean field values to strings', async () => {
    const decl = detailDeclaration(['active']);
    const records = [{ active: true }];
    const result = await generatePageStaticParams(decl, makeAdapter(records));
    expect(result).toEqual([{ active: 'true' }]);
  });

  it('builds multi-param sets from records containing all param fields', async () => {
    const decl: ResolvedPageDeclaration = {
      key: 'nested',
      declaration: {
        type: 'entity-detail',
        path: '/orgs/[org]/posts/[id]',
        title: 'Post',
        entity: 'post',
      },
      entityConfig: null,
      pattern: /^\/orgs\/([^/]+)\/posts\/([^/]+)$/,
      paramNames: ['org', 'id'],
    };

    const records = [
      { org: 'acme', id: '1' },
      { org: 'acme', id: '2' },
    ];
    const result = await generatePageStaticParams(decl, makeAdapter(records));
    expect(result).toEqual([
      { org: 'acme', id: '1' },
      { org: 'acme', id: '2' },
    ]);
  });
});

describe('generatePageStaticParams — entity-form (create)', () => {
  it('returns [{}] for a create form with no dynamic segments', async () => {
    const result = await generatePageStaticParams(createFormDeclaration([]), makeAdapter());
    expect(result).toEqual([{}]);
  });

  it('returns [] for a create form with dynamic segments', async () => {
    const result = await generatePageStaticParams(createFormDeclaration(['tenant']), makeAdapter());
    expect(result).toEqual([]);
  });
});

describe('generatePageStaticParams — entity-form (update/edit)', () => {
  it('enumerates param sets for an edit form', async () => {
    const records = [{ id: '10' }, { id: '20' }];
    const result = await generatePageStaticParams(
      editFormDeclaration(['id']),
      makeAdapter(records),
    );
    expect(result).toEqual([{ id: '10' }, { id: '20' }]);
  });

  it('returns [] when no adapter is registered for the edit form entity', async () => {
    const result = await generatePageStaticParams(editFormDeclaration(['id']), {});
    expect(result).toEqual([]);
  });
});

describe('generatePageStaticParams — custom', () => {
  it('always returns []', async () => {
    const result = await generatePageStaticParams(customDeclaration(), makeAdapter());
    expect(result).toEqual([]);
  });
});

describe('generatePageStaticParams — pagination (hasMore cursor)', () => {
  it('follows hasMore cursors to enumerate all records', async () => {
    let call = 0;
    const adapter = {
      post: {
        list: mock(async (opts: { cursor?: string }) => {
          call += 1;
          if (call === 1) {
            return { items: [{ id: '1' }], hasMore: true, nextCursor: 'c1' };
          }
          return { items: [{ id: '2' }], hasMore: false };
        }),
      },
    };

    const result = await generatePageStaticParams(detailDeclaration(['id']), adapter);
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });
});
