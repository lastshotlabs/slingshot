import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSqliteEntityAdapter, defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { defineEntity, field, index } from '../../packages/slingshot-core/src/entityConfig';
import type {
  EntityAdapter,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
} from '../../packages/slingshot-core/src/entityConfig';

// ---------------------------------------------------------------------------
// Test entity + operations
// ---------------------------------------------------------------------------

const Message = defineEntity('Message', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string(),
    authorId: field.string(),
    content: field.string(),
    status: field.enum(['sent', 'delivered', 'read', 'deleted'], { default: 'sent' }),
    score: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
    roomSummary: field.json({ optional: true }),
  },
  indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
  uniques: [{ fields: ['roomId', 'authorId'] }],
  softDelete: { field: 'status', value: 'deleted' },
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
});

const MessageOps = defineOperations(Message, {
  getByRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
  getOneByRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'one' }),
  isSent: op.exists({ fields: { id: 'param:id' }, check: { status: 'sent' } }),
  hasMessages: op.exists({ fields: { roomId: 'param:roomId' } }),
  markDelivered: op.transition({
    field: 'status',
    from: 'sent',
    to: 'delivered',
    match: { id: 'param:id' },
  }),
  updateContent: op.fieldUpdate({ match: { id: 'param:id' }, set: ['content'] }),
  deleteByRoom: op.batch({
    action: 'delete',
    filter: { roomId: 'param:roomId' },
    returns: 'count',
  }),
  markAllDelivered: op.batch({
    action: 'update',
    filter: { roomId: 'param:roomId', status: 'sent' },
    set: { status: 'delivered' },
    returns: 'count',
  }),
  searchContent: op.search({ fields: ['content'] }),
  countByRoom: op.aggregate({
    groupBy: 'roomId',
    compute: { count: 'count' },
    filter: { status: { $ne: 'deleted' } },
  }),
  filteredCountByRoom: op.aggregate({
    groupBy: 'roomId',
    compute: { count: 'count', totalScore: { sum: 'score' } },
    filter: {
      roomId: { $in: ['r1'] },
      content: { $contains: 'hello' },
    },
  }),
  totalCount: op.aggregate({ compute: { count: 'count' } }),
  materializeRoomSummary: op.computedAggregate({
    source: 'test_messages',
    target: 'test_messages',
    sourceFilter: {
      roomId: 'param:roomId',
      $or: [{ content: { $contains: 'hello' } }, { content: { $contains: 'world' } }],
    },
    targetMatch: { id: 'param:targetId' },
    materializeTo: 'roomSummary',
    compute: {
      totalScore: { sum: 'score' },
      matchingCount: { count: true },
    },
  }),
  upsertByRoomAuthor: op.upsert({
    match: ['roomId', 'authorId'],
    set: ['content', 'status'],
    onCreate: { id: 'uuid', createdAt: 'now' },
  }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type MessageEntity = InferEntity<typeof Message.fields>;
type MessageUpdateInput = InferUpdateInput<typeof Message.fields>;
type MessageAdapter = EntityAdapter<MessageEntity, Partial<MessageEntity>, MessageUpdateInput> &
  Record<string, unknown>;

describe('SQLite Operations Integration', () => {
  let db: Database;
  let adapter: MessageAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = createSqliteEntityAdapter(
      db,
      Message,
      MessageOps.operations,
    ) as unknown as MessageAdapter;
  });

  afterEach(() => {
    db.close();
  });

  async function seed() {
    const m1 = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'hello' });
    const m2 = await adapter.create({ roomId: 'r1', authorId: 'u2', content: 'world' });
    const m3 = await adapter.create({ roomId: 'r2', authorId: 'u1', content: 'hello there' });
    await adapter.update(m1.id, { score: 2 });
    await adapter.update(m2.id, { score: 3 });
    await adapter.update(m3.id, { score: 5 });
    return { m1, m2, m3 };
  }

  // -------------------------------------------------------------------------
  // CRUD basics on SQLite
  // -------------------------------------------------------------------------

  describe('CRUD', () => {
    it('creates and retrieves by ID', async () => {
      const created = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'test' });
      expect(created.id).toBeDefined();
      expect(created.roomId).toBe('r1');

      const fetched = await adapter.getById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.content).toBe('test');
    });

    it('updates a record', async () => {
      const created = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'original' });
      const updated = await adapter.update(created.id, { content: 'modified' });
      expect(updated!.content).toBe('modified');
    });

    it('soft-deletes a record', async () => {
      const created = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'test' });
      await adapter.delete(created.id);
      const fetched = await adapter.getById(created.id);
      expect(fetched).toBeNull(); // soft-deleted = invisible
    });

    it('lists with pagination', async () => {
      await seed();
      const result = await adapter.list();
      expect(result.items.length).toBe(3);
      expect(result.hasMore).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // op.lookup
  // -------------------------------------------------------------------------

  describe('op.lookup', () => {
    it('returns many by field match', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).getByRoom({ roomId: 'r1' });
      expect(result.items.length).toBe(2);
    });

    it('returns one by field match', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).getOneByRoom({ roomId: 'r1' });
      expect(result).not.toBeNull();
      expect(result.roomId).toBe('r1');
    });

    it('returns null for no match (one)', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).getOneByRoom({
        roomId: 'nonexistent',
      });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // op.exists
  // -------------------------------------------------------------------------

  describe('op.exists', () => {
    it('returns true when exists with check', async () => {
      const { m1 } = await seed();
      expect(await (adapter as Record<string, Function>).isSent({ id: m1.id })).toBe(true);
    });

    it('returns false after transition', async () => {
      const { m1 } = await seed();
      await (adapter as Record<string, Function>).markDelivered({ id: m1.id });
      expect(await (adapter as Record<string, Function>).isSent({ id: m1.id })).toBe(false);
    });

    it('checks existence without check field', async () => {
      await seed();
      expect(await (adapter as Record<string, Function>).hasMessages({ roomId: 'r1' })).toBe(true);
      expect(await (adapter as Record<string, Function>).hasMessages({ roomId: 'nope' })).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // op.transition
  // -------------------------------------------------------------------------

  describe('op.transition', () => {
    it('transitions and returns updated record', async () => {
      const { m1 } = await seed();
      const result = await (adapter as Record<string, Function>).markDelivered({ id: m1.id });
      expect(result).not.toBeNull();
      expect(result.status).toBe('delivered');

      // Verify persisted
      const fetched = await adapter.getById(m1.id);
      expect(fetched!.status).toBe('delivered');
    });

    it('returns null when precondition fails', async () => {
      const { m1 } = await seed();
      await (adapter as Record<string, Function>).markDelivered({ id: m1.id });
      const result = await (adapter as Record<string, Function>).markDelivered({ id: m1.id });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // op.fieldUpdate
  // -------------------------------------------------------------------------

  describe('op.fieldUpdate', () => {
    it('updates specified fields and persists', async () => {
      const { m1 } = await seed();
      const result = await (adapter as Record<string, Function>).updateContent(
        { id: m1.id },
        { content: 'updated' },
      );
      expect(result.content).toBe('updated');

      const fetched = await adapter.getById(m1.id);
      expect(fetched!.content).toBe('updated');
    });
  });

  // -------------------------------------------------------------------------
  // op.batch
  // -------------------------------------------------------------------------

  describe('op.batch', () => {
    it('deletes matching records', async () => {
      await seed();
      const count = await (adapter as Record<string, Function>).deleteByRoom({ roomId: 'r1' });
      expect(count).toBe(2);

      const remaining = await adapter.list();
      expect(remaining.items.length).toBe(1);
    });

    it('updates matching records', async () => {
      await seed();
      const count = await (adapter as Record<string, Function>).markAllDelivered({ roomId: 'r1' });
      expect(count).toBe(2);

      const result = await (adapter as Record<string, Function>).getByRoom({ roomId: 'r1' });
      expect(result.items.every((m: Record<string, unknown>) => m.status === 'delivered')).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // op.search
  // -------------------------------------------------------------------------

  describe('op.search', () => {
    it('finds by substring', async () => {
      await seed();
      const results = await (adapter as Record<string, Function>).searchContent('hello');
      expect(results.length).toBe(2); // 'hello' and 'hello there'
    });

    it('returns empty for no match', async () => {
      await seed();
      const results = await (adapter as Record<string, Function>).searchContent('xyz');
      expect(results.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // op.aggregate
  // -------------------------------------------------------------------------

  describe('op.aggregate', () => {
    it('groups and counts', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).countByRoom({});
      expect(Array.isArray(result)).toBe(true);
      const r1 = result.find((r: Record<string, unknown>) => r.roomId === 'r1');
      const r2 = result.find((r: Record<string, unknown>) => r.roomId === 'r2');
      expect(Number(r1.count)).toBe(2);
      expect(Number(r2.count)).toBe(1);
    });

    it('respects filter (excludes soft-deleted)', async () => {
      const { m1 } = await seed();
      await adapter.delete(m1.id); // soft-delete
      const result = await (adapter as Record<string, Function>).countByRoom({});
      const r1 = result.find((r: Record<string, unknown>) => r.roomId === 'r1');
      expect(Number(r1.count)).toBe(1);
    });

    it('computes total', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).totalCount({});
      expect(Number(result.count)).toBe(3);
    });

    it('respects filter operators and computes sum by group', async () => {
      await seed();
      const result = await (adapter as Record<string, Function>).filteredCountByRoom({});
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect((result[0] as Record<string, unknown>).roomId).toBe('r1');
      expect(Number((result[0] as Record<string, unknown>).count)).toBe(1);
      expect(Number((result[0] as Record<string, unknown>).totalScore)).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // op.computedAggregate
  // -------------------------------------------------------------------------

  describe('op.computedAggregate', () => {
    it('materializes a computed sum into the target record', async () => {
      const { m1 } = await seed();
      await (adapter as Record<string, Function>).materializeRoomSummary({
        roomId: 'r1',
        targetId: m1.id,
      });
      const fetched = await adapter.getById(m1.id);
      expect(fetched).not.toBeNull();
      expect((fetched as Record<string, unknown>).roomSummary).toEqual({
        totalScore: 5,
        matchingCount: 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // op.upsert
  // -------------------------------------------------------------------------

  describe('op.upsert', () => {
    it('creates when no match exists', async () => {
      const result = await (adapter as Record<string, Function>).upsertByRoomAuthor({
        roomId: 'r1',
        authorId: 'u1',
        content: 'first',
        status: 'sent',
        score: 0,
      });
      expect(result.roomId).toBe('r1');
      expect(result.content).toBe('first');

      const listed = await adapter.list();
      expect(listed.items.length).toBe(1);
    });

    it('updates when match exists', async () => {
      await (adapter as Record<string, Function>).upsertByRoomAuthor({
        roomId: 'r1',
        authorId: 'u1',
        content: 'first',
        status: 'sent',
        score: 0,
      });
      await (adapter as Record<string, Function>).upsertByRoomAuthor({
        roomId: 'r1',
        authorId: 'u1',
        content: 'second',
        status: 'delivered',
        score: 0,
      });

      const listed = await adapter.list();
      expect(listed.items.length).toBe(1);
      expect(listed.items[0].content).toBe('second');
    });
  });

  // -------------------------------------------------------------------------
  // Data persists across operations
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('all operations write to the same SQLite database', async () => {
      // Create via CRUD
      const m1 = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'hello' });

      // Transition via operation
      await (adapter as Record<string, Function>).markDelivered({ id: m1.id });

      // Verify via raw SQL
      const row = db.query('SELECT * FROM test_messages WHERE id = ?').get(m1.id) as Record<
        string,
        unknown
      >;
      expect(row).not.toBeNull();
      expect(row.status).toBe('delivered');

      // Verify via CRUD
      const fetched = await adapter.getById(m1.id);
      expect(fetched!.status).toBe('delivered');

      // Verify via lookup operation
      const byRoom = await (adapter as Record<string, Function>).getByRoom({ roomId: 'r1' });
      expect(byRoom.items.length).toBe(1);
      expect(byRoom.items[0].status).toBe('delivered');
    });
  });
});
