// ---------------------------------------------------------------------------
// WS Messages — backend factory functions
// ---------------------------------------------------------------------------
import type {
  StoreInfra,
  StoreType,
  StoredMessage,
  WsMessageRepository,
} from '@lastshotlabs/slingshot-core';
import { createSqliteInitializer } from './sqliteInit';

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<StoredMessage>;
  return (
    typeof message.id === 'string' &&
    typeof message.endpoint === 'string' &&
    typeof message.room === 'string' &&
    (typeof message.senderId === 'string' || message.senderId === null) &&
    typeof message.createdAt === 'number'
  );
}

function parseStoredMessage(raw: string): StoredMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `WsMessageRepository`.
 *
 * Messages are stored in a closure-owned `Map` keyed by `"<endpoint>\0<room>"`.
 * The null-byte separator guarantees there are no collisions between endpoint /
 * room combinations that share a common prefix. `persist()` enforces the
 * `maxCount` limit inline by splicing the oldest entries from the array.
 * History is returned oldest-first, matching the contract of all other backends.
 *
 * @returns An in-memory `WsMessageRepository` with a `clear()` method for test
 *   isolation.
 */
export function createMemoryWsMessageRepository(): WsMessageRepository {
  // key: "endpoint\0room"
  const store = new Map<string, StoredMessage[]>();

  /**
   * Produce a composite key for scoping messages to a specific endpoint/room pair.
   *
   * @param endpoint - The WebSocket endpoint identifier.
   * @param room - The room name within the endpoint.
   * @returns A null-byte-delimited composite key.
   */
  function scopeKey(endpoint: string, room: string) {
    return `${endpoint}\0${room}`;
  }

  return {
    persist(message, config) {
      const key = scopeKey(message.endpoint, message.room);
      if (!store.has(key)) store.set(key, []);
      const msgs = store.get(key) ?? [];
      store.set(key, msgs);
      msgs.push(message);
      if (msgs.length > config.maxCount) {
        msgs.splice(0, msgs.length - config.maxCount);
      }
      return Promise.resolve(message);
    },

    getHistory(endpoint, room, opts) {
      const key = scopeKey(endpoint, room);
      const msgs = store.get(key) ?? [];
      const limit = opts?.limit ?? 50;

      let filtered = msgs.slice();

      if (opts?.before) {
        const idx = filtered.findIndex(m => m.id === opts.before);
        if (idx === -1) return Promise.resolve([]);
        if (idx > 0) filtered = filtered.slice(0, idx);
        else return Promise.resolve([]);
      } else if (opts?.after) {
        const idx = filtered.findIndex(m => m.id === opts.after);
        if (idx === -1) return Promise.resolve([]);
        if (idx >= 0) filtered = filtered.slice(idx + 1);
      }

      return Promise.resolve(filtered.slice(-limit));
    },

    clear() {
      store.clear();
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a Redis-backed `WsMessageRepository`.
 *
 * Messages are stored as JSON strings in Redis lists keyed by
 * `wsmsg:<endpoint>\0<room>`. `persist()` uses `LPUSH` (prepend) + `LTRIM` to
 * maintain a bounded ring of the most recent `maxCount` messages, then resets
 * the key TTL with `EXPIRE`. `getHistory()` reverses the list so that the
 * result is in oldest-first order (consistent with the memory and SQLite
 * backends). `clear()` deletes all keys seen during the lifetime of this
 * instance — the in-memory `knownKeys` set tracks them.
 *
 * @param redis - Redis client with `lpush`, `ltrim`, `expire`, `lrange`, and
 *   `del` methods.
 * @returns A Redis-backed `WsMessageRepository`.
 */
export function createRedisWsMessageRepository(redis: {
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  expire(key: string, seconds: number): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
}): WsMessageRepository {
  const knownKeys = new Set<string>();

  /**
   * Produce the namespaced Redis list key for an endpoint/room pair.
   *
   * @param endpoint - The WebSocket endpoint identifier.
   * @param room - The room name within the endpoint.
   * @returns Redis key in the form `wsmsg:<endpoint>\0<room>`.
   */
  function rkey(endpoint: string, room: string) {
    return `wsmsg:${endpoint}\0${room}`;
  }

  return {
    async persist(message, config) {
      const key = rkey(message.endpoint, message.room);
      knownKeys.add(key);
      const serialized = JSON.stringify(message);
      await redis.lpush(key, serialized);
      await redis.ltrim(key, 0, config.maxCount - 1);
      await redis.expire(key, config.ttlSeconds);
      return message;
    },

    async getHistory(endpoint, room, opts) {
      const key = rkey(endpoint, room);
      const limit = opts?.limit ?? 50;
      const raw = await redis.lrange(key, 0, -1);
      let msgs = raw
        .map(parseStoredMessage)
        .filter((message): message is StoredMessage => message !== null)
        .reverse(); // oldest-first

      if (opts?.before) {
        const idx = msgs.findIndex(m => m.id === opts.before);
        if (idx === -1) return [];
        if (idx > 0) msgs = msgs.slice(0, idx);
        else return [];
      } else if (opts?.after) {
        const idx = msgs.findIndex(m => m.id === opts.after);
        if (idx === -1) return [];
        if (idx >= 0) msgs = msgs.slice(idx + 1);
      }

      return msgs.slice(-limit);
    },

    async clear() {
      if (knownKeys.size === 0) return;
      await redis.del(...knownKeys);
      knownKeys.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Create a MongoDB-backed `WsMessageRepository`.
 *
 * Messages are stored in the `ws_messages` collection. The schema uses
 * `_id: String` (the caller-supplied message ID) and has a compound index on
 * `(endpoint, room, createdAt desc, _id desc)` for efficient history queries.
 * A separate TTL index on `createdAt` with `expireAfterSeconds: DEFAULT_TTL_SECONDS`
 * (24 h) ensures automatic cleanup. `persist()` enforces `maxCount` by counting
 * and deleting the oldest documents after each insert. `clear()` is best-effort
 * (errors are swallowed) so test teardown never fails.
 *
 * @param conn - The Mongoose `Connection` for the app database.
 * @param mongoosePkg - The `mongoose` module, passed as `unknown` to keep
 *   mongoose out of the static import graph.
 * @returns A MongoDB-backed `WsMessageRepository`.
 */
/** Minimal interface for the Mongoose model operations used by the WS message repository. */
interface WsMessageModel {
  create(doc: object): Promise<unknown>;
  countDocuments(filter: object): Promise<number>;
  find(filter: object): {
    sort(order: object): {
      limit(n: number): {
        select(fields: string): Promise<Array<{ _id: string }>>;
        lean(): Promise<WsMessageDoc[]>;
      };
    };
  };
  findById(id: string): { lean(): Promise<WsMessageDoc | null> };
  deleteMany(filter: object): Promise<unknown>;
}

interface WsMessageDoc {
  _id: string;
  endpoint: string;
  room: string;
  senderId?: string | null;
  payload?: unknown;
  createdAt: number;
}

export function createMongoWsMessageRepository(
  conn: { models: Record<string, unknown>; model(name: string, schema: unknown): unknown },
  mongoosePkg: unknown,
): WsMessageRepository {
  let model: WsMessageModel | null = null;

  function getModel(): WsMessageModel {
    if (model) return model;
    const mongoose = mongoosePkg as typeof import('mongoose');

    const schema = new mongoose.Schema(
      {
        _id: { type: String, default: () => crypto.randomUUID() },
        endpoint: { type: String, required: true },
        room: { type: String, required: true },
        senderId: { type: String, default: null },
        payload: { type: mongoose.Schema.Types.Mixed },
        createdAt: { type: Number, required: true },
      },
      { collection: 'ws_messages' },
    );

    schema.index({ endpoint: 1, room: 1, createdAt: -1, _id: -1 });
    schema.index({ createdAt: 1 }, { expireAfterSeconds: DEFAULT_TTL_SECONDS });

    model = conn.model('WsMessage', schema) as WsMessageModel;
    return model;
  }

  return {
    async persist(message, config) {
      const Model = getModel();
      await Model.create({
        _id: message.id,
        endpoint: message.endpoint,
        room: message.room,
        senderId: message.senderId,
        payload: message.payload,
        createdAt: message.createdAt,
      });

      const count = await Model.countDocuments({ endpoint: message.endpoint, room: message.room });
      if (count > config.maxCount) {
        const oldest = await Model.find({ endpoint: message.endpoint, room: message.room })
          .sort({ createdAt: 1, _id: 1 })
          .limit(count - config.maxCount)
          .select('_id');
        if (oldest.length > 0) {
          await Model.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
        }
      }

      return message;
    },

    async getHistory(endpoint, room, opts) {
      const Model = getModel();
      const limit = opts?.limit ?? 50;
      const filter: Record<string, unknown> = { endpoint, room };

      if (opts?.before) {
        const cursor = await Model.findById(opts.before).lean();
        if (!cursor) return [];
        filter['$or'] = [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: opts.before } },
        ];
      } else if (opts?.after) {
        const cursor = await Model.findById(opts.after).lean();
        if (!cursor) return [];
        filter['$or'] = [
          { createdAt: { $gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $gt: opts.after } },
        ];
      }

      const docs = await Model.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
      return docs.reverse().map(d => ({
        id: d._id,
        endpoint: d.endpoint,
        room: d.room,
        senderId: d.senderId ?? null,
        payload: d.payload,
        createdAt: d.createdAt,
      }));
    },

    async clear() {
      // Mongo clear — drop all documents. Used for test isolation.
      try {
        await getModel().deleteMany({});
      } catch {
        /* best-effort */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `WsMessageRepository`.
 *
 * Messages are stored in the `ws_messages` table. An index on
 * `(endpoint, room, created_at DESC)` supports efficient scoped history queries.
 * `persist()` uses modulo-based trimming: the oldest-exceeding-`maxCount`
 * messages and TTL-expired messages are deleted every `trimInterval` writes
 * per room (10% of `maxCount`, minimum 10). This avoids a COUNT query on every
 * single write while still bounding table size. `clear()` is best-effort —
 * errors are swallowed so test teardown never fails.
 *
 * @param db - SQLite database handle with `run()` / `query()` methods.
 * @returns A SQLite-backed `WsMessageRepository`.
 */
export function createSqliteWsMessageRepository(db: {
  run(sql: string, params?: unknown[]): void;
  query<T>(sql: string): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] };
}): WsMessageRepository {
  const trimCounters = new Map<string, number>();

  /**
   * Produce a composite scope key for tracking per-room write counters.
   *
   * @param endpoint - The WebSocket endpoint identifier.
   * @param room - The room name within the endpoint.
   * @returns A null-byte-delimited composite key.
   */
  function scopeKey(endpoint: string, room: string) {
    return `${endpoint}\0${room}`;
  }

  const ensureTable = createSqliteInitializer(db, () => {
    db.run(`
      CREATE TABLE IF NOT EXISTS ws_messages (
        id         TEXT PRIMARY KEY,
        endpoint   TEXT NOT NULL,
        room       TEXT NOT NULL,
        sender_id  TEXT,
        payload    TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_ws_messages_scope ON ws_messages (endpoint, room, created_at DESC)',
    );
  });

  return {
    persist(message, config) {
      ensureTable();
      db.run(
        'INSERT INTO ws_messages (id, endpoint, room, sender_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          message.id,
          message.endpoint,
          message.room,
          message.senderId,
          JSON.stringify(message.payload),
          message.createdAt,
        ],
      );

      // Modulo-based trimming
      const key = scopeKey(message.endpoint, message.room);
      const counter = (trimCounters.get(key) ?? 0) + 1;
      const trimInterval = Math.max(10, Math.floor(config.maxCount * 0.1));
      trimCounters.set(key, counter);
      // Cap the counter map to prevent unbounded growth from abandoned rooms
      if (trimCounters.size > 10_000) {
        const oldest = trimCounters.keys().next().value;
        if (oldest) trimCounters.delete(oldest);
      }

      if (counter >= trimInterval) {
        trimCounters.set(key, 0);
        db.run(
          `DELETE FROM ws_messages WHERE endpoint = ? AND room = ? AND id NOT IN (
            SELECT id FROM ws_messages WHERE endpoint = ? AND room = ? ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
          [message.endpoint, message.room, message.endpoint, message.room, config.maxCount],
        );
        const ttlMs = config.ttlSeconds * 1000;
        db.run('DELETE FROM ws_messages WHERE endpoint = ? AND room = ? AND created_at < ?', [
          message.endpoint,
          message.room,
          Date.now() - ttlMs,
        ]);
      }

      return Promise.resolve(message);
    },

    getHistory(endpoint, room, opts) {
      ensureTable();
      const limit = opts?.limit ?? 50;
      let sql: string;
      let params: unknown[];

      if (opts?.before) {
        sql = `
          SELECT * FROM ws_messages
          WHERE endpoint = ? AND room = ? AND (created_at, id) < (
            (SELECT created_at FROM ws_messages WHERE id = ?), ?
          )
          ORDER BY created_at DESC, id DESC LIMIT ?
        `;
        params = [endpoint, room, opts.before, opts.before, limit];
      } else if (opts?.after) {
        sql = `
          SELECT * FROM ws_messages
          WHERE endpoint = ? AND room = ? AND (created_at, id) > (
            (SELECT created_at FROM ws_messages WHERE id = ?), ?
          )
          ORDER BY created_at ASC, id ASC LIMIT ?
        `;
        params = [endpoint, room, opts.after, opts.after, limit];
      } else {
        sql =
          'SELECT * FROM ws_messages WHERE endpoint = ? AND room = ? ORDER BY created_at DESC, id DESC LIMIT ?';
        params = [endpoint, room, limit];
      }

      interface WsMessageRow {
        id: string;
        endpoint: string;
        room: string;
        sender_id: string | null;
        payload: string;
        created_at: number;
      }
      const rows = db.query<WsMessageRow>(sql).all(...params);
      if (!opts?.after) rows.reverse();

      return Promise.resolve(
        rows.map(r => ({
          id: r.id,
          endpoint: r.endpoint,
          room: r.room,
          senderId: r.sender_id,
          payload: parseJsonValue(r.payload),
          createdAt: r.created_at,
        })),
      );
    },

    clear() {
      try {
        ensureTable();
        db.run('DELETE FROM ws_messages');
        trimCounters.clear();
      } catch {
        /* best-effort */
      }
      return Promise.resolve();
    },
  };
}

/**
 * WebSocket message repository factories keyed by `StoreType`.
 *
 * Each factory creates a `WsMessageRepository` backed by the corresponding store.
 * The `postgres` factory is async (creates the table on first use), so the overall
 * type allows `Promise<WsMessageRepository>` returns. Use `resolveRepoAsync` at the
 * call site to handle async factories.
 *
 * Store coverage:
 * - `"memory"` — in-process `Map` (development/testing only).
 * - `"redis"` — Redis list-backed adapter.
 * - `"sqlite"` — SQLite-backed adapter with modulo-based trimming.
 * - `"mongo"` — MongoDB-backed adapter with TTL index.
 * - `"postgres"` — native Postgres-backed adapter with keyset pagination.
 */
export const wsMessageFactories: Record<
  StoreType,
  (infra: StoreInfra) => WsMessageRepository | Promise<WsMessageRepository>
> = {
  memory: () => createMemoryWsMessageRepository(),
  sqlite: infra => createSqliteWsMessageRepository(infra.getSqliteDb()),
  redis: infra => createRedisWsMessageRepository(infra.getRedis()),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoWsMessageRepository(conn, mg);
  },
  postgres: async infra => {
    const { pool } = infra.getPostgres();
    const { createPostgresWsMessageRepository } = await import('./postgresWsMessages');
    return createPostgresWsMessageRepository(pool);
  },
};
