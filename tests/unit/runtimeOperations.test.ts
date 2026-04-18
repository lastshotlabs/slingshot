import { beforeEach, describe, expect, it } from 'bun:test';
import { createEntityFactories, defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { defineEntity, field } from '../../packages/slingshot-core/src/entityConfig';

// ---------------------------------------------------------------------------
// Test entity
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
  softDelete: { field: 'status', value: 'deleted' },
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
});

// ---------------------------------------------------------------------------
// Operations — using the builder API (types preserved naturally)
// ---------------------------------------------------------------------------

const MessageOps = defineOperations(Message, {
  getByRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
  getByRoomAndAuthor: op.lookup({
    fields: { roomId: 'param:roomId', authorId: 'param:authorId' },
    returns: 'one',
  }),
  isSent: op.exists({ fields: { id: 'param:id' }, check: { status: 'sent' } }),
  hasMessages: op.exists({ fields: { roomId: 'param:roomId' } }),
  markDelivered: op.transition({
    field: 'status',
    from: 'sent',
    to: 'delivered',
    match: { id: 'param:id' },
  }),
  markRead: op.transition({
    field: 'status',
    from: 'delivered',
    to: 'read',
    match: { id: 'param:id' },
    set: { score: 'param:score' },
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Runtime Operation Execution (Memory)', () => {
  const factories = createEntityFactories(Message, MessageOps.operations);
  let adapter: ReturnType<typeof factories.memory>;

  beforeEach(async () => {
    adapter = factories.memory();
    await adapter.clear();
  });

  async function seed() {
    const m1 = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'hello' } as any);
    const m2 = await adapter.create({ roomId: 'r1', authorId: 'u2', content: 'world' } as any);
    const m3 = await adapter.create({
      roomId: 'r2',
      authorId: 'u1',
      content: 'hello there',
    } as any);
    await adapter.update(m1.id, { score: 2 } as any);
    await adapter.update(m2.id, { score: 3 } as any);
    await adapter.update(m3.id, { score: 5 } as any);
    return { m1, m2, m3 };
  }

  // -------------------------------------------------------------------------
  // op.lookup
  // -------------------------------------------------------------------------

  describe('op.lookup', () => {
    it('returns many by field match', async () => {
      await seed();
      const result = await adapter.getByRoom({ roomId: 'r1' });
      expect(result.items.length).toBe(2);
    });

    it('returns empty for no match', async () => {
      await seed();
      const result = await adapter.getByRoom({ roomId: 'nonexistent' });
      expect(result.items.length).toBe(0);
    });

    it('returns one by compound field match', async () => {
      const { m1 } = await seed();
      const result = await adapter.getByRoomAndAuthor({ roomId: 'r1', authorId: 'u1' });
      expect(result).not.toBeNull();
      expect((result as unknown as Record<string, unknown>).id).toBe(m1.id);
    });

    it('returns null for no match (one)', async () => {
      await seed();
      const result = await adapter.getByRoomAndAuthor({ roomId: 'r1', authorId: 'u99' });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // op.exists
  // -------------------------------------------------------------------------

  describe('op.exists', () => {
    it('returns true when record exists with matching check', async () => {
      const { m1 } = await seed();
      expect(await adapter.isSent({ id: m1.id })).toBe(true);
    });

    it('returns false when check field does not match', async () => {
      const { m1 } = await seed();
      await adapter.markDelivered({ id: m1.id });
      expect(await adapter.isSent({ id: m1.id })).toBe(false);
    });

    it('checks existence without check field', async () => {
      await seed();
      expect(await adapter.hasMessages({ roomId: 'r1' })).toBe(true);
      expect(await adapter.hasMessages({ roomId: 'nonexistent' })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // op.transition
  // -------------------------------------------------------------------------

  describe('op.transition', () => {
    it('transitions state when precondition matches', async () => {
      const { m1 } = await seed();
      const result = await adapter.markDelivered({ id: m1.id });
      expect(result).not.toBeNull();
      expect((result as Record<string, unknown>).status).toBe('delivered');
    });

    it('returns null when precondition fails', async () => {
      const { m1 } = await seed();
      await adapter.markDelivered({ id: m1.id });
      const result = await adapter.markDelivered({ id: m1.id });
      expect(result).toBeNull();
    });

    it('sets side-effect fields including params', async () => {
      const { m1 } = await seed();
      await adapter.markDelivered({ id: m1.id });
      const result = await adapter.markRead({ id: m1.id, score: 42 });
      expect(result).not.toBeNull();
      expect((result as Record<string, unknown>).status).toBe('read');
      expect((result as Record<string, unknown>).score).toBe(42);
    });

    it('returns null for nonexistent record', async () => {
      const result = await adapter.markDelivered({ id: 'nonexistent' });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // op.fieldUpdate
  // -------------------------------------------------------------------------

  describe('op.fieldUpdate', () => {
    it('updates specified fields only', async () => {
      const { m1 } = await seed();
      const result = await adapter.updateContent({ id: m1.id }, { content: 'updated' });
      expect(result.content).toBe('updated');
      expect(result.roomId).toBe('r1');
    });

    it('throws for nonexistent record', async () => {
      expect(adapter.updateContent({ id: 'nonexistent' }, { content: 'x' })).rejects.toThrow(
        'Record not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // op.batch
  // -------------------------------------------------------------------------

  describe('op.batch', () => {
    it('deletes matching records and returns count', async () => {
      await seed();
      const deleted = await adapter.deleteByRoom({ roomId: 'r1' });
      expect(deleted).toBe(2);
      const remaining = await adapter.list();
      expect(remaining.items.length).toBe(1);
    });

    it('updates matching records and returns count', async () => {
      await seed();
      const updated = await adapter.markAllDelivered({ roomId: 'r1' });
      expect(updated).toBe(2);
    });

    it('returns 0 when no records match', async () => {
      await seed();
      const deleted = await adapter.deleteByRoom({ roomId: 'nonexistent' });
      expect(deleted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // op.search
  // -------------------------------------------------------------------------

  describe('op.search', () => {
    it('finds records by case-insensitive substring', async () => {
      await seed();
      const results = await adapter.searchContent('hello');
      expect(results.length).toBe(2);
    });

    it('returns empty for no match', async () => {
      await seed();
      const results = await adapter.searchContent('xyz');
      expect(results.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // op.aggregate
  // -------------------------------------------------------------------------

  describe('op.aggregate', () => {
    it('groups and counts', async () => {
      await seed();
      const result = await adapter.countByRoom({});
      expect(Array.isArray(result)).toBe(true);
    });

    it('computes total without groupBy', async () => {
      await seed();
      const result = await adapter.totalCount({});
      expect((result as Record<string, unknown>).count).toBe(3);
    });

    it('respects filter operators and computes sum by group', async () => {
      await seed();
      const result = (await adapter.filteredCountByRoom({})) as Record<string, unknown>[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0].roomId).toBe('r1');
      expect(result[0].count).toBe(1);
      expect(result[0].totalScore).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // op.computedAggregate
  // -------------------------------------------------------------------------

  describe('op.computedAggregate', () => {
    it('materializes a computed sum into the target record', async () => {
      const { m1 } = await seed();
      await adapter.materializeRoomSummary({ roomId: 'r1', targetId: m1.id });
      const updated = await adapter.getById(m1.id);
      expect(updated).not.toBeNull();
      expect((updated as Record<string, unknown>).roomSummary).toEqual({
        totalScore: 5,
        matchingCount: 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // CRUD still works alongside operations
  // -------------------------------------------------------------------------

  describe('CRUD + operations coexist', () => {
    it('CRUD methods are unaffected', async () => {
      const created = await adapter.create({
        roomId: 'r1',
        authorId: 'u1',
        content: 'test',
      } as any);
      expect(created.id).toBeDefined();

      const fetched = await adapter.getById(created.id);
      expect(fetched).not.toBeNull();

      const updated = await adapter.update(created.id, { content: 'updated' });
      expect(updated!.content).toBe('updated');

      await adapter.delete(created.id);
      const deleted = await adapter.getById(created.id);
      expect(deleted).toBeNull();
    });
  });
});
