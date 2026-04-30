/**
 * Memory adapter CRUD, pagination, scoping, and constraint tests.
 *
 * Exercises the config-driven in-memory EntityAdapter produced by
 * `createMemoryEntityAdapter()` across the core behaviour surface:
 * create, read, update, delete, cursor pagination, tenant scoping,
 * TTL eviction, soft-delete, unique constraints, upsert semantics,
 * empty collections, and boundary values.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { createMemoryEntityAdapter } from '../../src/configDriven/memoryAdapter';
import { op } from '../../src/configDriven/operations';

// ---------------------------------------------------------------------------
// Entity definitions
// ---------------------------------------------------------------------------

const Task = defineEntity('Task', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
    status: field.string({ default: 'open' }),
    priority: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  pagination: {
    cursor: { fields: ['id'] },
    defaultLimit: 10,
    maxLimit: 50,
  },
});

const TenantItem = defineEntity('TenantItem', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string(),
    name: field.string(),
  },
  tenant: { field: 'tenantId' },
});

const TtlRecord = defineEntity('TtlRecord', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    data: field.string(),
  },
  ttl: { defaultSeconds: 1 },
});

const SoftItem = defineEntity('SoftItem', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
    deletedAt: field.date({ optional: true }),
  },
  softDelete: { field: 'deletedAt', strategy: 'non-null' },
});

const UniqueEntity = defineEntity('UniqueEntity', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    email: field.string(),
    slug: field.string(),
  },
  uniques: [{ fields: ['email'] }],
  indexes: [index(['slug'], { unique: true })],
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

type AnyAdapter = ReturnType<typeof createMemoryEntityAdapter>;

function taskAdapter() {
  return createMemoryEntityAdapter<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >(Task);
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

describe('Memory adapter — CRUD operations', () => {
  let adapter: AnyAdapter;
  beforeEach(() => {
    adapter = taskAdapter();
  });

  test('create returns a record with auto-generated defaults', async () => {
    const result = await adapter.create({ title: 'Buy milk' });
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).title).toBe('Buy milk');
    expect((result as Record<string, unknown>).status).toBe('open');
    expect((result as Record<string, unknown>).priority).toBe(0);
    expect((result as Record<string, unknown>).id).toBeDefined();
    expect((result as Record<string, unknown>).createdAt).toBeInstanceOf(Date);
  });

  test('getById retrieves a created record', async () => {
    const created = (await adapter.create({ title: 'Test' })) as Record<string, unknown>;
    const found = await adapter.getById(created.id as string);
    expect(found).toBeDefined();
    expect((found as Record<string, unknown>).title).toBe('Test');
  });

  test('getById returns null for non-existent id', async () => {
    const found = await adapter.getById('nonexistent-id');
    expect(found).toBeNull();
  });

  test('update modifies fields and returns the updated record', async () => {
    const created = (await adapter.create({ title: 'Old' })) as Record<string, unknown>;
    const updated = await adapter.update(created.id as string, { title: 'New' });
    expect(updated).toBeDefined();
    expect((updated as Record<string, unknown>).title).toBe('New');
  });

  test('update returns null for non-existent id', async () => {
    const result = await adapter.update('nonexistent-id', { title: 'Nope' });
    expect(result).toBeNull();
  });

  test('update applies onUpdate fields', async () => {
    const created = (await adapter.create({ title: 'Test' })) as Record<string, unknown>;
    const originalUpdatedAt = created.updatedAt;
    // Small delay to ensure time has advanced
    await new Promise(r => setTimeout(r, 5));
    const updated = (await adapter.update(created.id as string, {
      title: 'Changed',
    })) as Record<string, unknown>;
    expect((updated.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(
      (originalUpdatedAt as Date).getTime(),
    );
  });

  test('delete removes a record and returns true', async () => {
    const created = (await adapter.create({ title: 'To delete' })) as Record<string, unknown>;
    const deleted = await adapter.delete(created.id as string);
    expect(deleted).toBe(true);
    const found = await adapter.getById(created.id as string);
    expect(found).toBeNull();
  });

  test('delete returns false for non-existent id', async () => {
    const deleted = await adapter.delete('nonexistent-id');
    expect(deleted).toBe(false);
  });

  test('list returns all created records', async () => {
    await adapter.create({ title: 'A' });
    await adapter.create({ title: 'B' });
    await adapter.create({ title: 'C' });
    const result = await adapter.list();
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });

  test('clear removes all records', async () => {
    await adapter.create({ title: 'A' });
    await adapter.create({ title: 'B' });
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cursor Pagination
// ---------------------------------------------------------------------------

describe('Memory adapter — cursor pagination', () => {
  test('paginated list returns correct pages with cursors', async () => {
    const adapter = taskAdapter();
    // Create 25 items
    for (let i = 0; i < 25; i++) {
      await adapter.create({ title: `Task ${i}` });
    }

    // First page (defaultLimit = 10)
    const page1 = await adapter.list();
    expect(page1.items).toHaveLength(10);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    // Second page
    const page2 = await adapter.list({ cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(10);
    expect(page2.hasMore).toBe(true);

    // Third page
    const page3 = await adapter.list({ cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(5);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeUndefined();

    // All items across pages should be unique
    const allIds = [
      ...page1.items.map(i => (i as Record<string, unknown>).id),
      ...page2.items.map(i => (i as Record<string, unknown>).id),
      ...page3.items.map(i => (i as Record<string, unknown>).id),
    ];
    expect(new Set(allIds).size).toBe(25);
  });

  test('custom limit is respected', async () => {
    const adapter = taskAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.create({ title: `Task ${i}` });
    }

    const result = await adapter.list({ limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });

  test('limit exceeding maxLimit is clamped', async () => {
    const adapter = taskAdapter();
    // maxLimit is 50 for Task entity
    for (let i = 0; i < 60; i++) {
      await adapter.create({ title: `Task ${i}` });
    }

    const result = await adapter.list({ limit: 100 });
    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant Scoping
// ---------------------------------------------------------------------------

describe('Memory adapter — tenant scoping', () => {
  test('list filters by tenant field when provided', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(TenantItem);

    await adapter.create({ name: 'A', tenantId: 'tenant-1' });
    await adapter.create({ name: 'B', tenantId: 'tenant-1' });
    await adapter.create({ name: 'C', tenantId: 'tenant-2' });

    const t1 = await adapter.list({ filter: { tenantId: 'tenant-1' } } as never);
    expect(t1.items).toHaveLength(2);

    const t2 = await adapter.list({ filter: { tenantId: 'tenant-2' } } as never);
    expect(t2.items).toHaveLength(1);
  });

  test('getById with filter rejects wrong tenant', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(TenantItem);

    const created = (await adapter.create({
      name: 'Secret',
      tenantId: 'tenant-1',
    })) as Record<string, unknown>;

    const found = await adapter.getById(created.id as string, { tenantId: 'tenant-2' });
    expect(found).toBeNull();

    const foundCorrect = await adapter.getById(created.id as string, { tenantId: 'tenant-1' });
    expect(foundCorrect).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TTL Behavior
// ---------------------------------------------------------------------------

describe('Memory adapter — TTL behavior', () => {
  test('expired records are not returned by getById', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(TtlRecord);

    const created = (await adapter.create({ data: 'ephemeral' })) as Record<string, unknown>;

    // Record should exist immediately
    const found = await adapter.getById(created.id as string);
    expect(found).toBeDefined();

    // Wait for TTL to expire (1 second + buffer)
    await new Promise(r => setTimeout(r, 1100));

    const expired = await adapter.getById(created.id as string);
    expect(expired).toBeNull();
  });

  test('update refreshes TTL', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(TtlRecord);

    const created = (await adapter.create({ data: 'refresh-test' })) as Record<string, unknown>;

    // Wait 700ms, then update to refresh TTL
    await new Promise(r => setTimeout(r, 700));
    await adapter.update(created.id as string, { data: 'refreshed' });

    // Wait another 700ms — past original TTL but within refreshed TTL
    await new Promise(r => setTimeout(r, 700));
    const found = await adapter.getById(created.id as string);
    expect(found).toBeDefined();
    expect((found as Record<string, unknown>).data).toBe('refreshed');
  });
});

// ---------------------------------------------------------------------------
// Soft Delete
// ---------------------------------------------------------------------------

describe('Memory adapter — soft delete', () => {
  test('delete sets the soft-delete field instead of removing the record', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(SoftItem);

    const created = (await adapter.create({ name: 'Soft test' })) as Record<string, unknown>;
    const deleted = await adapter.delete(created.id as string);
    expect(deleted).toBe(true);

    // Record should not be visible via getById
    const found = await adapter.getById(created.id as string);
    expect(found).toBeNull();

    // But should not appear in list either
    const list = await adapter.list();
    expect(list.items).toHaveLength(0);
  });

  test('soft-deleted records are excluded from list', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(SoftItem);

    const a = (await adapter.create({ name: 'Keep' })) as Record<string, unknown>;
    const b = (await adapter.create({ name: 'Remove' })) as Record<string, unknown>;
    await adapter.delete(b.id as string);

    const list = await adapter.list();
    expect(list.items).toHaveLength(1);
    expect((list.items[0] as Record<string, unknown>).name).toBe('Keep');
  });

  test('cannot update a soft-deleted record', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(SoftItem);

    const created = (await adapter.create({ name: 'Gone' })) as Record<string, unknown>;
    await adapter.delete(created.id as string);

    const result = await adapter.update(created.id as string, { name: 'Revived?' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unique Constraints
// ---------------------------------------------------------------------------

describe('Memory adapter — unique constraints', () => {
  test('create rejects duplicate on unique field', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(UniqueEntity);

    await adapter.create({ email: 'a@test.com', slug: 'alpha' });

    await expect(
      adapter.create({ email: 'a@test.com', slug: 'beta' }) as Promise<unknown>,
    ).rejects.toMatchObject({ status: 409 });
  });

  test('create rejects duplicate on unique index', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(UniqueEntity);

    await adapter.create({ email: 'x@test.com', slug: 'one' });

    await expect(
      adapter.create({ email: 'y@test.com', slug: 'one' }) as Promise<unknown>,
    ).rejects.toMatchObject({ status: 409 });
  });

  test('update rejects if it would violate a unique constraint', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(UniqueEntity);

    const a = (await adapter.create({ email: 'first@test.com', slug: 's1' })) as Record<
      string,
      unknown
    >;
    await adapter.create({ email: 'second@test.com', slug: 's2' });

    await expect(
      adapter.update(a.id as string, { email: 'second@test.com' }) as Promise<unknown>,
    ).rejects.toMatchObject({ status: 409 });
  });

  test('update to the same value on self does not trigger violation', async () => {
    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(UniqueEntity);

    const a = (await adapter.create({ email: 'me@test.com', slug: 'mine' })) as Record<
      string,
      unknown
    >;
    // Updating other fields while keeping the same email should succeed
    const updated = await adapter.update(a.id as string, { slug: 'mine-v2' });
    expect(updated).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Upsert Semantics
// ---------------------------------------------------------------------------

describe('Memory adapter — upsert semantics', () => {
  const UpsertEntity = defineEntity('UpsertEntity', {
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      email: field.string(),
      name: field.string(),
      updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
    },
    indexes: [index(['email'], { unique: true })],
  });

  test('upsert creates on first call and updates on subsequent calls', async () => {
    const ops = {
      upsertByEmail: op.upsert({
        match: ['email'],
        set: ['name'],
        onCreate: { id: 'uuid', updatedAt: 'now' },
      }),
    };

    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(UpsertEntity, ops);

    const upsert = adapter.upsertByEmail as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const first = await upsert({ email: 'a@b.com', name: 'Alice' });
    expect(first.name).toBe('Alice');
    const firstId = first.id;

    const second = await upsert({ email: 'a@b.com', name: 'Alice Updated' });
    expect(second.id).toBe(firstId);
    expect(second.name).toBe('Alice Updated');

    const list = await adapter.list();
    expect(list.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Empty Collections
// ---------------------------------------------------------------------------

describe('Memory adapter — empty collections', () => {
  test('list on empty store returns empty array', async () => {
    const adapter = taskAdapter();
    const result = await adapter.list();
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test('list with cursor on empty store returns empty array', async () => {
    const adapter = taskAdapter();
    // Construct a cursor that would be valid in a populated store
    const fakeCursor = Buffer.from(JSON.stringify({ id: 'none' })).toString('base64url');
    const result = await adapter.list({ cursor: fakeCursor });
    expect(result.items).toHaveLength(0);
  });

  test('clear on empty store is a no-op', async () => {
    const adapter = taskAdapter();
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary Values
// ---------------------------------------------------------------------------

describe('Memory adapter — boundary values', () => {
  test('handles empty string values', async () => {
    const adapter = taskAdapter();
    const created = (await adapter.create({ title: '' })) as Record<string, unknown>;
    expect(created.title).toBe('');

    const found = (await adapter.getById(created.id as string)) as Record<string, unknown>;
    expect(found.title).toBe('');
  });

  test('handles very long string values', async () => {
    const adapter = taskAdapter();
    const longTitle = 'x'.repeat(10_000);
    const created = (await adapter.create({ title: longTitle })) as Record<string, unknown>;
    expect(created.title).toBe(longTitle);
  });

  test('update with empty object is a no-op but returns the record', async () => {
    const adapter = taskAdapter();
    const created = (await adapter.create({ title: 'Original' })) as Record<string, unknown>;
    const updated = (await adapter.update(created.id as string, {})) as Record<string, unknown>;
    expect(updated.title).toBe('Original');
  });

  test('filter with non-matching key returns empty list', async () => {
    const adapter = taskAdapter();
    await adapter.create({ title: 'A' });
    const result = await adapter.list({ filter: { title: 'ZZZ' } } as never);
    expect(result.items).toHaveLength(0);
  });

  test('delete with filter rejects non-matching filter', async () => {
    const adapter = taskAdapter();
    const created = (await adapter.create({ title: 'Protected' })) as Record<string, unknown>;
    const deleted = await adapter.delete(created.id as string, { title: 'Wrong' });
    expect(deleted).toBe(false);

    // Record should still exist
    const found = await adapter.getById(created.id as string);
    expect(found).toBeDefined();
  });

  test('update with filter rejects non-matching filter', async () => {
    const adapter = taskAdapter();
    const created = (await adapter.create({ title: 'Protected' })) as Record<string, unknown>;
    const result = await adapter.update(
      created.id as string,
      { title: 'Hacked' },
      {
        title: 'Wrong',
      },
    );
    expect(result).toBeNull();
  });

  test('numeric zero as a default is preserved', async () => {
    const adapter = taskAdapter();
    const created = (await adapter.create({ title: 'Zero test' })) as Record<string, unknown>;
    expect(created.priority).toBe(0);
  });
});
