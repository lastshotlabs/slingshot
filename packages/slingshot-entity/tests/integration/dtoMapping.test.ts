/**
 * Baked-in DTO mapping E2E:
 *  - `private: true` field options are stripped from generated route responses
 *  - Per-route `responses[status].transform` runs on response bodies
 *  - Entity-level `dto.default` projects records before send (and applies to arrays
 *    and `{ items: [...] }` paginated shapes)
 *  - Named variants in `dto.<variant>` selected per CRUD route via `routes.<op>.dto`
 */
import { describe, expect, it } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';

const records = new Map<string, Record<string, unknown>>();
let idCounter = 0;

function createMemoryAdapter() {
  return {
    create: (data: unknown) => {
      const id = String(++idCounter);
      const record = { id, ...(data as Record<string, unknown>) };
      records.set(id, record);
      return Promise.resolve(record);
    },
    getById: (id: string) => Promise.resolve(records.get(id) ?? null),
    list: (opts?: { filter?: unknown; limit?: number; cursor?: string }) => {
      const items = [...records.values()];
      const limit = opts?.limit ?? items.length;
      return Promise.resolve({ items: items.slice(0, limit), hasMore: items.length > limit });
    },
    update: (id: string, data: unknown) => {
      const existing = records.get(id);
      if (!existing) return Promise.resolve(null);
      const updated = { ...existing, ...(data as Record<string, unknown>) };
      records.set(id, updated);
      return Promise.resolve(updated);
    },
    delete: (id: string) => {
      records.delete(id);
      return Promise.resolve(true);
    },
  };
}

function asResolvedConfig(config: Record<string, unknown>): ResolvedEntityConfig {
  return {
    _systemFields: {
      createdBy: 'createdBy',
      updatedBy: 'updatedBy',
      ownerField: 'ownerId',
      tenantField: 'tenantId',
      version: 'version',
    },
    _storageFields: {
      mongoPkField: '_id',
      ttlField: '_expires_at',
      mongoTtlField: '_expiresAt',
    },
    _conventions: {},
    ...config,
  } as unknown as ResolvedEntityConfig;
}

describe('private field stripping', () => {
  it('omits private fields from POST/create response', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        passwordHash: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: true,
        },
        internalNotes: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: true,
          private: true,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
    });
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const req = new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', passwordHash: 'secret', internalNotes: 'hr-only' }),
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe('a@b.com');
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('internalNotes');
  });

  it('omits private fields from GET/byId and list responses', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        passwordHash: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: true,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
    });
    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'a@b.com', passwordHash: 'secret-1' });
    await adapter.create({ email: 'c@d.com', passwordHash: 'secret-2' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const getRes = await router.fetch(new Request('http://localhost/users/1'));
    expect(getRes.status).toBe(200);
    const single = (await getRes.json()) as Record<string, unknown>;
    expect(single).not.toHaveProperty('passwordHash');
    expect(single.email).toBe('a@b.com');

    const listRes = await router.fetch(new Request('http://localhost/users'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(2);
    for (const item of list.items) {
      expect(item).not.toHaveProperty('passwordHash');
    }
  });
});

describe('entity-level dto.default', () => {
  it('runs the default mapper on every record (single, array, paginated items)', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        passwordHash: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: true,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      dto: {
        default: (record: Record<string, unknown>) => ({
          id: record.id,
          email: record.email,
          // Add a derived field as evidence the mapper ran
          handle: typeof record.email === 'string' ? record.email.split('@')[0] : null,
        }),
      },
    });
    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'alice@example.com', passwordHash: 'x' });
    await adapter.create({ email: 'bob@example.com', passwordHash: 'y' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    // Single record (GET /:id)
    const getRes = await router.fetch(new Request('http://localhost/users/1'));
    const single = (await getRes.json()) as Record<string, unknown>;
    expect(single.handle).toBe('alice');
    expect(single).not.toHaveProperty('passwordHash');

    // Paginated list ({ items, ... })
    const listRes = await router.fetch(new Request('http://localhost/users'));
    const list = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(list.items.map(i => i.handle)).toEqual(['alice', 'bob']);
    for (const item of list.items) {
      expect(item).not.toHaveProperty('passwordHash');
    }
  });
});

describe('named DTO variants', () => {
  it('routes.<op>.dto picks the named variant per CRUD route', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        role: { type: 'string', primary: false, immutable: false, optional: false, private: false },
        passwordHash: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: true,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      dto: {
        // Default: full DTO (id, email, role)
        default: (r: Record<string, unknown>) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          shape: 'default',
        }),
        // List variant: slimmer (id, email)
        list: (r: Record<string, unknown>) => ({ id: r.id, email: r.email, shape: 'list' }),
        // Public variant: id only
        public: (r: Record<string, unknown>) => ({ id: r.id, shape: 'public' }),
      },
      routes: {
        list: { dto: 'list' },
        get: { dto: 'public' },
        // create unset → falls through to default
      },
    });
    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'a@b.com', role: 'admin', passwordHash: 'x' });
    await adapter.create({ email: 'c@d.com', role: 'user', passwordHash: 'y' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    // GET /users → list variant
    const listRes = await router.fetch(new Request('http://localhost/users'));
    const list = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(2);
    for (const item of list.items) {
      expect(item.shape).toBe('list');
      expect(item).not.toHaveProperty('role');
      expect(item).not.toHaveProperty('passwordHash');
    }

    // GET /users/:id → public variant
    const getRes = await router.fetch(new Request('http://localhost/users/1'));
    const single = (await getRes.json()) as Record<string, unknown>;
    expect(single.shape).toBe('public');
    expect(single).not.toHaveProperty('email');
    expect(single).not.toHaveProperty('role');

    // POST /users → default variant (no override on create)
    const postRes = await router.fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'e@f.com', role: 'editor', passwordHash: 'z' }),
      }),
    );
    const created = (await postRes.json()) as Record<string, unknown>;
    expect(created.shape).toBe('default');
    expect(created.role).toBe('editor');
    expect(created).not.toHaveProperty('passwordHash');
  });

  it('falls through to no mapping when neither variant nor default is set', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        passwordHash: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: true,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      // No dto config — only private stripping should happen
    });
    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'a@b.com', passwordHash: 'secret' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const getRes = await router.fetch(new Request('http://localhost/users/1'));
    const single = (await getRes.json()) as Record<string, unknown>;
    expect(single.email).toBe('a@b.com');
    expect(single).not.toHaveProperty('passwordHash');
    // No mapper ran — original keys preserved verbatim.
    expect(single.id).toBe('1');
  });
});

describe('input variants (field.inputVariants + routes.<op>.input)', () => {
  it('strips fields gated by inputVariants from the public create body', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        // role is admin-only — public POST /users should silently strip it.
        role: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
          inputVariants: ['admin'],
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      // routes.create unset → default variant — `role` should be stripped.
    });
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const res = await router.fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Client tries to set role on the public route.
        body: JSON.stringify({ email: 'a@b.com', role: 'admin' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe('a@b.com');
    // role was silently stripped before reaching the adapter.
    expect(body).not.toHaveProperty('role');
    expect(records.get('1')).not.toHaveProperty('role');
  });

  it('admin variant route accepts the gated field', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        role: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
          inputVariants: ['admin'],
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      routes: {
        // Mark the create route as the admin variant — `role` is now allowed.
        create: { input: 'admin' },
      },
    });
    const adapter = createMemoryAdapter();
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const res = await router.fetch(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', role: 'admin' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe('a@b.com');
    expect(body.role).toBe('admin');
    expect(records.get('1')?.role).toBe('admin');
  });

  it('named-op route honours routes.operations[opName].dto variant', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        role: { type: 'string', primary: false, immutable: false, optional: false, private: false },
      },
      _pkField: 'id',
      _storageName: 'users',
      dto: {
        default: (r: Record<string, unknown>) => ({ id: r.id, email: r.email, shape: 'default' }),
        admin: (r: Record<string, unknown>) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          shape: 'admin',
        }),
      },
      routes: {
        operations: {
          adminGet: { dto: 'admin' },
        },
      },
    });
    await records.set('1', { id: '1', email: 'a@b.com', role: 'admin' });
    const adapter = {
      ...createMemoryAdapter(),
      adminGet: (params: Record<string, unknown>) =>
        Promise.resolve(records.get(params.id as string) ?? null),
    };
    const operations = {
      adminGet: { kind: 'lookup' as const, returns: 'one' as const, fields: { id: 'param:id' } },
    };
    const router = buildBareEntityRoutes(config, operations, adapter);

    const res = await router.fetch(new Request('http://localhost/users/admin-get/1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The 'admin' variant ran — `role` is present and shape='admin'.
    expect(body.shape).toBe('admin');
    expect(body.role).toBe('admin');
  });

  it('routes.<op>.transform runs after dto projection on CRUD direct paths', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      dto: {
        default: (r: Record<string, unknown>) => ({ id: r.id, email: r.email, mapped: true }),
      },
      routes: {
        list: {
          // Wrap the list response in an envelope; transform sees the projected dto.
          transform: (value: unknown) => {
            const v = value as { items: Record<string, unknown>[] };
            return { count: v.items.length, items: v.items };
          },
        },
        get: {
          transform: (value: unknown) => ({ wrapped: true, payload: value }),
        },
      },
    });
    await adapter_create_helper(config, [{ email: 'a@b.com' }, { email: 'c@d.com' }]);

    async function adapter_create_helper(_cfg: typeof config, seeds: Record<string, unknown>[]) {
      // helper: noop; we'll use a fresh adapter below
      return seeds;
    }

    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'a@b.com' });
    await adapter.create({ email: 'c@d.com' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    // List wrap
    const listRes = await router.fetch(new Request('http://localhost/users'));
    const listBody = (await listRes.json()) as {
      count: number;
      items: { mapped: boolean; email: string }[];
    };
    expect(listBody.count).toBe(2);
    // Transform saw the post-projection items (mapped: true present).
    expect(listBody.items[0]?.mapped).toBe(true);

    // Get envelope
    const getRes = await router.fetch(new Request('http://localhost/users/1'));
    const getBody = (await getRes.json()) as {
      wrapped: boolean;
      payload: { mapped: boolean; email: string };
    };
    expect(getBody.wrapped).toBe(true);
    expect(getBody.payload.mapped).toBe(true);
    expect(getBody.payload.email).toBe('a@b.com');
  });

  it('strips gated fields from default-variant update', async () => {
    records.clear();
    idCounter = 0;
    const config = asResolvedConfig({
      name: 'User',
      fields: {
        id: {
          type: 'string',
          primary: true,
          immutable: true,
          optional: false,
          default: 'uuid',
          private: false,
        },
        email: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
        },
        role: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          private: false,
          inputVariants: ['admin'],
        },
      },
      _pkField: 'id',
      _storageName: 'users',
      // routes.update unset → default variant — role can't be changed via PATCH.
    });
    const adapter = createMemoryAdapter();
    await adapter.create({ email: 'a@b.com', role: 'member' });
    const router = buildBareEntityRoutes(config, undefined, adapter);

    const res = await router.fetch(
      new Request('http://localhost/users/1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }), // attempted privilege escalation
      }),
    );
    expect(res.status).toBe(200);
    // role unchanged in storage — the gated field was stripped.
    expect(records.get('1')?.role).toBe('member');
  });
});
