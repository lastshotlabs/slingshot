import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineEntity, field } from '../../src';
import { createEntitySeeder, seedAll, topoSortEntities } from '../../src/seeder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory adapter for testing. */
function createMemoryAdapter<T extends { id?: string }>() {
  const store: T[] = [];
  return {
    store,
    create: async (input: T): Promise<T> => {
      const record = { ...input, id: input.id ?? crypto.randomUUID() };
      store.push(record as T);
      return record as T;
    },
    clear: async () => {
      store.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// topoSort
// ---------------------------------------------------------------------------

describe('topoSortEntities', () => {
  it('sorts parent entities before children', () => {
    const User = defineEntity('User', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
    });

    const Post = defineEntity('Post', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        title: field.string(),
        authorId: field.string(),
      },
      relations: {
        author: { kind: 'belongsTo', target: 'User', foreignKey: 'authorId' },
      },
    });

    // Provide in reverse order — Post before User
    const sorted = topoSortEntities([Post, User]);
    const names = sorted.map(c => c.name);
    expect(names.indexOf('User')).toBeLessThan(names.indexOf('Post'));
  });

  it('handles entities with no relations', () => {
    const A = defineEntity('A', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
    });
    const B = defineEntity('B', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
    });

    const sorted = topoSortEntities([B, A]);
    expect(sorted).toHaveLength(2);
  });

  it('throws on circular dependencies', () => {
    const A = defineEntity('CycleA', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        bId: field.string(),
      },
      relations: {
        b: { kind: 'belongsTo', target: 'CycleB', foreignKey: 'bId' },
      },
    });

    const B = defineEntity('CycleB', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        aId: field.string(),
      },
      relations: {
        a: { kind: 'belongsTo', target: 'CycleA', foreignKey: 'aId' },
      },
    });

    expect(() => topoSortEntities([A, B])).toThrow(/Circular/);
  });

  it('ignores hasMany relations for ordering', () => {
    const User = defineEntity('User', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
      relations: {
        posts: { kind: 'hasMany', target: 'Post', foreignKey: 'authorId' },
      },
    });

    const Post = defineEntity('Post', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        authorId: field.string(),
      },
      relations: {
        author: { kind: 'belongsTo', target: 'User', foreignKey: 'authorId' },
      },
    });

    // Should not create a circular dependency
    const sorted = topoSortEntities([Post, User]);
    expect(sorted.map(c => c.name)).toEqual(['User', 'Post']);
  });
});

// ---------------------------------------------------------------------------
// createEntitySeeder
// ---------------------------------------------------------------------------

describe('createEntitySeeder', () => {
  const UserConfig = defineEntity('User', {
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      name: field.string(),
      email: field.string({ format: 'email' }),
      role: field.enum(['admin', 'member']),
    },
  });

  const createSchema = z.object({
    name: z.string(),
    email: z.string().email(),
    role: z.enum(['admin', 'member']),
  });

  it('seeds the requested number of records', async () => {
    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: UserConfig,
      adapter,
      createSchema,
      generateOptions: { seed: 42 },
    });

    const users = await seeder.seed(5);
    expect(users).toHaveLength(5);
    expect(adapter.store).toHaveLength(5);

    for (const user of users) {
      const u = user as Record<string, unknown>;
      expect(u).toHaveProperty('id');
      expect(u).toHaveProperty('name');
      expect(u).toHaveProperty('email');
      expect(typeof u.email).toBe('string');
      expect(u.email as string).toContain('@');
    }
  });

  it('seedOne creates exactly one record', async () => {
    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: UserConfig,
      adapter,
      createSchema,
      generateOptions: { seed: 1 },
    });

    const user = await seeder.seedOne();
    expect(adapter.store).toHaveLength(1);
    expect(user).toHaveProperty('id');
  });

  it('applies overrides', async () => {
    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: UserConfig,
      adapter,
      createSchema,
      generateOptions: { seed: 1 },
    });

    const users = await seeder.seed(3, { role: 'admin' });
    for (const user of users) {
      expect((user as Record<string, unknown>).role).toBe('admin');
    }
  });

  it('clear empties the store', async () => {
    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: UserConfig,
      adapter,
      createSchema,
      generateOptions: { seed: 1 },
    });

    await seeder.seed(10);
    expect(adapter.store).toHaveLength(10);

    await seeder.clear();
    expect(adapter.store).toHaveLength(0);
  });

  it('exposes entity metadata', () => {
    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: UserConfig,
      adapter,
      createSchema,
    });

    expect(seeder.entityName).toBe('User');
    expect(seeder.pkField).toBe('id');
  });
});

// ---------------------------------------------------------------------------
// Bug regression: seeded batches produce distinct records
// ---------------------------------------------------------------------------

describe('createEntitySeeder — seeded distinctness', () => {
  it('seed() with a seed produces distinct records (not identical)', async () => {
    const Config = defineEntity('Item', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
        value: field.number(),
      },
    });

    const createSchema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const adapter = createMemoryAdapter();
    const seeder = createEntitySeeder({
      config: Config,
      adapter,
      createSchema,
      generateOptions: { seed: 42 },
    });

    const items = await seeder.seed(10);
    // Records should be distinct — if re-seeding bug exists, all 10 would be identical
    const names = new Set(items.map((i: any) => i.name));
    expect(names.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// seedAll (multi-entity orchestration)
// ---------------------------------------------------------------------------

describe('seedAll', () => {
  it('seeds parent entities before children and wires FKs', async () => {
    const UserConfig = defineEntity('User', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
    });

    const PostConfig = defineEntity('Post', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        title: field.string(),
        authorId: field.string(),
      },
      relations: {
        author: { kind: 'belongsTo', target: 'User', foreignKey: 'authorId' },
      },
    });

    const userAdapter = createMemoryAdapter();
    const postAdapter = createMemoryAdapter();

    const userCreateSchema = z.object({ name: z.string() });
    const postCreateSchema = z.object({ title: z.string(), authorId: z.string() });

    const result = await seedAll(
      {
        entities: [
          { config: PostConfig, adapter: postAdapter, createSchema: postCreateSchema },
          { config: UserConfig, adapter: userAdapter, createSchema: userCreateSchema },
        ],
        generateOptions: { seed: 42 },
      },
      {
        User: { count: 3 },
        Post: { count: 10 },
      },
    );

    expect(result.records.get('User')).toHaveLength(3);
    expect(result.records.get('Post')).toHaveLength(10);

    // Every post's authorId should match a user's id
    const userIds = new Set(
      (result.records.get('User') as Array<Record<string, unknown>>).map(u => u.id),
    );
    for (const post of result.records.get('Post') as Array<Record<string, unknown>>) {
      expect(userIds.has(post.authorId)).toBe(true);
    }
  });

  it('seeded seedAll produces distinct records (not identical)', async () => {
    const UserConfig = defineEntity('User', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
        email: field.string({ format: 'email' }),
      },
    });

    const userAdapter = createMemoryAdapter();
    const userCreateSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });

    const result = await seedAll(
      {
        entities: [{ config: UserConfig, adapter: userAdapter, createSchema: userCreateSchema }],
        generateOptions: { seed: 42 },
      },
      { User: { count: 10 } },
    );

    const users = result.records.get('User') as Array<Record<string, unknown>>;
    const names = new Set(users.map(u => u.name));
    // All 10 should be distinct — if re-seeding bug exists, all would be identical
    expect(names.size).toBeGreaterThan(1);
  });

  it('clearAll removes records in reverse order', async () => {
    const A = defineEntity('A', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
    });
    const B = defineEntity('B', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        aId: field.string(),
      },
      relations: {
        a: { kind: 'belongsTo', target: 'A', foreignKey: 'aId' },
      },
    });

    const aAdapter = createMemoryAdapter();
    const bAdapter = createMemoryAdapter();

    const result = await seedAll(
      {
        entities: [
          { config: B, adapter: bAdapter, createSchema: z.object({ aId: z.string() }) },
          { config: A, adapter: aAdapter, createSchema: z.object({}) },
        ],
        generateOptions: { seed: 1 },
      },
      { A: { count: 2 }, B: { count: 5 } },
    );

    expect(aAdapter.store.length).toBe(2);
    expect(bAdapter.store.length).toBe(5);

    await result.clearAll();
    expect(aAdapter.store.length).toBe(0);
    expect(bAdapter.store.length).toBe(0);
  });
});
