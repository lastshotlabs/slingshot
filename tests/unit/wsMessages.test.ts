import { beforeEach, describe, expect, test } from 'bun:test';
import type { StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';
import {
  createMemoryWsMessageRepository,
  createMongoWsMessageRepository,
} from '../../src/framework/persistence/wsMessages';

const ENDPOINT = '/ws';

describe('wsMessages (memory backend)', () => {
  let repo: WsMessageRepository;
  let defaults: { maxCount: number; ttlSeconds: number };

  beforeEach(async () => {
    repo = createMemoryWsMessageRepository();
    defaults = { maxCount: 100, ttlSeconds: 86400 };
  });

  function makeMessage(
    room: string,
    data: { senderId?: string | null; payload: unknown },
  ): StoredMessage {
    return {
      id: crypto.randomUUID(),
      endpoint: ENDPOINT,
      room,
      senderId: data.senderId ?? null,
      payload: data.payload,
      createdAt: Date.now(),
    };
  }

  test('persist stores message', async () => {
    const msg = makeMessage('chat', { senderId: 'user1', payload: 'hello' });
    const result = await repo.persist(msg, defaults);

    expect(result).not.toBeNull();
    expect(result.room).toBe('chat');
    expect(result.senderId).toBe('user1');
    expect(result.payload).toBe('hello');
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
  });

  test('persist defaults senderId to null', async () => {
    const msg = makeMessage('chat', { payload: 'anon' });
    const result = await repo.persist(msg, defaults);
    expect(result.senderId).toBeNull();
  });

  test('getHistory returns stored messages in order', async () => {
    await repo.persist(makeMessage('chat', { senderId: 'u1', payload: 'first' }), defaults);
    await repo.persist(makeMessage('chat', { senderId: 'u2', payload: 'second' }), defaults);
    await repo.persist(makeMessage('chat', { senderId: 'u1', payload: 'third' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('first');
    expect(history[1].payload).toBe('second');
    expect(history[2].payload).toBe('third');
  });

  test('getHistory returns empty for non-existent room', async () => {
    const history = await repo.getHistory(ENDPOINT, 'nonexistent');
    expect(history).toEqual([]);
  });

  test('maxCount trims oldest messages', async () => {
    const config = { maxCount: 3, ttlSeconds: 86400 };

    await repo.persist(makeMessage('chat', { payload: '1' }), config);
    await repo.persist(makeMessage('chat', { payload: '2' }), config);
    await repo.persist(makeMessage('chat', { payload: '3' }), config);
    await repo.persist(makeMessage('chat', { payload: '4' }), config);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('2');
    expect(history[1].payload).toBe('3');
    expect(history[2].payload).toBe('4');
  });

  test('before cursor returns messages before the cursor', async () => {
    await repo.persist(makeMessage('chat', { payload: '1' }), defaults);
    await repo.persist(makeMessage('chat', { payload: '2' }), defaults);
    const m3 = await repo.persist(makeMessage('chat', { payload: '3' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat', { before: m3.id });
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('1');
    expect(history[1].payload).toBe('2');
  });

  test('after cursor returns messages after the cursor', async () => {
    const m1 = await repo.persist(makeMessage('chat', { payload: '1' }), defaults);
    await repo.persist(makeMessage('chat', { payload: '2' }), defaults);
    await repo.persist(makeMessage('chat', { payload: '3' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat', { after: m1.id });
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('2');
    expect(history[1].payload).toBe('3');
  });

  test('limit restricts result count', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.persist(makeMessage('chat', { payload: `msg-${i}` }), defaults);
    }

    const history = await repo.getHistory(ENDPOINT, 'chat', { limit: 3 });
    expect(history).toHaveLength(3);
    // Returns last 3
    expect(history[0].payload).toBe('msg-7');
    expect(history[1].payload).toBe('msg-8');
    expect(history[2].payload).toBe('msg-9');
  });

  test('messages support complex payloads', async () => {
    const payload = { text: 'hello', metadata: { nested: true, count: 42 } };
    await repo.persist(makeMessage('chat', { payload }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].payload).toEqual(payload);
  });

  test('multiple rooms are independent', async () => {
    await repo.persist(makeMessage('room1', { payload: 'r1-msg' }), defaults);
    await repo.persist(makeMessage('room2', { payload: 'r2-msg' }), defaults);

    const h1 = await repo.getHistory(ENDPOINT, 'room1');
    const h2 = await repo.getHistory(ENDPOINT, 'room2');

    expect(h1).toHaveLength(1);
    expect(h1[0].payload).toBe('r1-msg');
    expect(h2).toHaveLength(1);
    expect(h2[0].payload).toBe('r2-msg');
  });

  test('clear resets all state', async () => {
    await repo.persist(makeMessage('chat', { payload: 'hello' }), defaults);
    await repo.clear();

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MongoDB backend — cursor-based pagination & persist trimming
// ---------------------------------------------------------------------------

describe('wsMessages (mongo backend)', () => {
  const ENDPOINT = '/ws';

  interface MockDoc {
    _id: string;
    endpoint: string;
    room: string;
    senderId?: string | null;
    payload?: unknown;
    createdAt: number;
  }

  function makeMockMongoModel() {
    const docs: MockDoc[] = [];

    const model = {
      create: async (doc: object) => {
        docs.push(doc as MockDoc);
      },
      countDocuments: async (filter: { endpoint: string; room: string }) => {
        return docs.filter(d => d.endpoint === filter.endpoint && d.room === filter.room).length;
      },
      find: (filter: Record<string, unknown>) => {
        let filtered = docs.filter(d => {
          if (filter.endpoint && d.endpoint !== filter.endpoint) return false;
          if (filter.room && d.room !== filter.room) return false;
          if (filter['$or']) {
            const orClauses = filter['$or'] as Array<Record<string, unknown>>;
            return orClauses.some(clause => {
              const ct = clause.createdAt;
              const idCmp = clause._id;
              if (typeof ct === 'object' && ct !== null && typeof idCmp === 'undefined') {
                // Simple createdAt comparison: { createdAt: { $lt: N } }
                const ctObj = ct as Record<string, number>;
                if ('$lt' in ctObj) return d.createdAt < ctObj['$lt'];
                if ('$gt' in ctObj) return d.createdAt > ctObj['$gt'];
              }
              if (typeof ct === 'number' && typeof idCmp === 'object' && idCmp !== null) {
                // Compound clause: { createdAt: N, _id: { $lt/$gt: id } }
                if (d.createdAt !== ct) return false;
                const idObj = idCmp as Record<string, string>;
                if ('$lt' in idObj) return d._id < idObj['$lt'];
                if ('$gt' in idObj) return d._id > idObj['$gt'];
              }
              return false;
            });
          }
          if (filter['_id']) {
            const idFilter = filter['_id'] as Record<string, string[]>;
            if (idFilter['$in']) return idFilter['$in'].includes(d._id);
          }
          return true;
        });

        return {
          sort: (order: Record<string, number>) => {
            const key = Object.keys(order)[0] === 'createdAt' ? 'createdAt' : '_id';
            const dir = Object.values(order)[0];
            filtered = filtered.sort((a, b) => {
              const va = key === 'createdAt' ? a.createdAt : a._id;
              const vb = key === 'createdAt' ? b.createdAt : b._id;
              return dir === 1 ? (va < vb ? -1 : 1) : (va > vb ? -1 : 1);
            });
            return {
              limit: (n: number) => ({
                select: async () => filtered.slice(0, n).map(d => ({ _id: d._id })),
                lean: async () => filtered.slice(0, n),
              }),
            };
          },
        };
      },
      findById: (id: string) => ({
        lean: async () => docs.find(d => d._id === id) ?? null,
      }),
      deleteMany: async (filter: Record<string, unknown>) => {
        if (Object.keys(filter).length === 0) {
          // Clear all
          docs.length = 0;
          return;
        }
        const idFilter = filter['_id'] as Record<string, string[]> | undefined;
        if (idFilter?.['$in']) {
          const idsToRemove = new Set(idFilter['$in']);
          for (let i = docs.length - 1; i >= 0; i--) {
            if (idsToRemove.has(docs[i]._id)) docs.splice(i, 1);
          }
        }
      },
    };

    return { model, docs };
  }

  function makeMockConn(model: unknown) {
    const models = {};
    return {
      models: models as Record<string, unknown>,
      model() {
        return model;
      },
    };
  }

  function makeMockMongoose() {
    const SchemaClass = class {
      index() {}
    } as any;
    SchemaClass.Types = { Mixed: 'Mixed' };
    return { Schema: SchemaClass };
  }

  function makeMessage(
    room: string,
    data: { senderId?: string | null; payload: unknown },
    createdAt?: number,
  ): StoredMessage {
    return {
      id: crypto.randomUUID(),
      endpoint: ENDPOINT,
      room,
      senderId: data.senderId ?? null,
      payload: data.payload,
      createdAt: createdAt ?? Date.now(),
    };
  }

  test('persist trims oldest when count exceeds maxCount', async () => {
    const { model, docs } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 2, ttlSeconds: 86400 };
    await repo.persist(makeMessage('chat', { payload: '1' }, 1000), config);
    await repo.persist(makeMessage('chat', { payload: '2' }, 2000), config);
    await repo.persist(makeMessage('chat', { payload: '3' }, 3000), config);

    // After persisting 3 with maxCount=2, oldest should be trimmed
    expect(docs.length).toBe(2);
  });

  test('getHistory with before cursor applies $or filter', async () => {
    const { model } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 100, ttlSeconds: 86400 };
    const m1 = makeMessage('chat', { payload: '1' }, 1000);
    const m2 = makeMessage('chat', { payload: '2' }, 2000);
    const m3 = makeMessage('chat', { payload: '3' }, 3000);
    await repo.persist(m1, config);
    await repo.persist(m2, config);
    await repo.persist(m3, config);

    // getHistory with before: m3 should return messages before m3
    const history = await repo.getHistory(ENDPOINT, 'chat', { before: m3.id });
    // Should only contain messages with createdAt < 3000
    expect(history.every(m => m.createdAt < 3000)).toBe(true);
  });

  test('getHistory with after cursor applies $or filter', async () => {
    const { model } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 100, ttlSeconds: 86400 };
    const m1 = makeMessage('chat', { payload: '1' }, 1000);
    const m2 = makeMessage('chat', { payload: '2' }, 2000);
    const m3 = makeMessage('chat', { payload: '3' }, 3000);
    await repo.persist(m1, config);
    await repo.persist(m2, config);
    await repo.persist(m3, config);

    // getHistory with after: m1 should return messages after m1
    const history = await repo.getHistory(ENDPOINT, 'chat', { after: m1.id });
    expect(history.every(m => m.createdAt > 1000)).toBe(true);
  });

  test('getHistory with before cursor for nonexistent id returns all', async () => {
    const { model } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 100, ttlSeconds: 86400 };
    await repo.persist(makeMessage('chat', { payload: '1' }, 1000), config);
    await repo.persist(makeMessage('chat', { payload: '2' }, 2000), config);

    // Nonexistent cursor id — findById returns null, no $or filter applied
    const history = await repo.getHistory(ENDPOINT, 'chat', { before: 'nonexistent-id' });
    expect(history).toHaveLength(2);
  });

  test('getHistory with after cursor for nonexistent id returns all', async () => {
    const { model } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 100, ttlSeconds: 86400 };
    await repo.persist(makeMessage('chat', { payload: '1' }, 1000), config);
    await repo.persist(makeMessage('chat', { payload: '2' }, 2000), config);

    const history = await repo.getHistory(ENDPOINT, 'chat', { after: 'nonexistent-id' });
    expect(history).toHaveLength(2);
  });

  test('clear swallows errors (best-effort)', async () => {
    const failingModel = {
      deleteMany: async () => { throw new Error('db error'); },
    };
    // Need to also provide findById, find, etc for getModel
    const connModels = {};
    const conn = {
      models: connModels as Record<string, unknown>,
      model() { return failingModel; },
    };
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    // Should not throw
    await expect(repo.clear()).resolves.toBeUndefined();
  });

  test('getHistory maps senderId null correctly', async () => {
    const { model } = makeMockMongoModel();
    const conn = makeMockConn(model);
    const mg = makeMockMongoose();
    const repo = createMongoWsMessageRepository(conn as any, mg);

    const config = { maxCount: 100, ttlSeconds: 86400 };
    await repo.persist(makeMessage('chat', { payload: 'test' }, 1000), config);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].senderId).toBeNull();
  });
});
