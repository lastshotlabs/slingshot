/**
 * Postgres-backed WebSocket message repository.
 *
 * Stores messages in the `ws_messages` table with a compound index on
 * `(endpoint, room, created_at DESC, id DESC)` for efficient scoped history
 * queries. `persist()` enforces `maxCount` by deleting the oldest messages
 * after each insert. `getHistory()` uses keyset pagination for `before`/`after`
 * cursors. `clear()` is best-effort (errors are swallowed for test isolation).
 */
import type { Pool } from 'pg';
import type { StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';
import { createPostgresInitializer } from './postgresInit';

/**
 * Row shape returned by Postgres for the `ws_messages` table.
 *
 * Note: The `pg` driver returns `BIGINT` columns as strings because JavaScript
 * `number` cannot represent all 64-bit integers. `created_at` is converted via
 * `Number()` in {@link rowToMessage}, which is safe for `Date.now()` epoch
 * milliseconds (well within 53-bit integer range).
 */
interface WsMessageRow {
  id: string;
  endpoint: string;
  room: string;
  sender_id: string | null;
  payload: unknown; // JSONB is parsed by pg driver
  created_at: string; // pg returns BIGINT as string
}

/**
 * Convert a Postgres row to a `StoredMessage`, mapping snake_case columns to
 * camelCase properties and converting `BIGINT` string to `number`.
 *
 * @param row - A row from the `ws_messages` table.
 * @returns The equivalent `StoredMessage`.
 */
function rowToMessage(row: WsMessageRow): StoredMessage {
  return {
    id: row.id,
    endpoint: row.endpoint,
    room: row.room,
    senderId: row.sender_id,
    payload: row.payload,
    createdAt: Number(row.created_at),
  };
}

/**
 * Create a Postgres-backed `WsMessageRepository`.
 *
 * Messages are stored in the `ws_messages` table with a compound index on
 * `(endpoint, room, created_at DESC, id DESC)` for efficient scoped history
 * queries. `persist()` enforces `maxCount` by deleting the oldest messages
 * after each insert. `getHistory()` uses keyset pagination for `before`/`after`
 * cursors. `clear()` is best-effort (errors are swallowed for test isolation).
 *
 * @param pool - A `pg.Pool` instance from the shared Postgres connection.
 * @returns A promise that resolves to a Postgres-backed `WsMessageRepository`.
 */
export async function createPostgresWsMessageRepository(pool: Pool): Promise<WsMessageRepository> {
  const ensureSchema = createPostgresInitializer(pool, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ws_messages (
        id          TEXT    PRIMARY KEY,
        endpoint    TEXT    NOT NULL,
        room        TEXT    NOT NULL,
        sender_id   TEXT,
        payload     JSONB,
        created_at  BIGINT  NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ws_messages_scope
        ON ws_messages (endpoint, room, created_at DESC, id DESC)
    `);
  });
  await ensureSchema();

  return {
    async persist(message, config) {
      await pool.query('BEGIN');
      try {
        await pool.query(
          `INSERT INTO ws_messages (id, endpoint, room, sender_id, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            message.id,
            message.endpoint,
            message.room,
            message.senderId,
            JSON.stringify(message.payload),
            message.createdAt,
          ],
        );

        // Enforce maxCount by deleting oldest messages beyond the limit
        await pool.query(
          `DELETE FROM ws_messages
           WHERE endpoint = $1 AND room = $2
             AND id NOT IN (
               SELECT id FROM ws_messages
               WHERE endpoint = $1 AND room = $2
               ORDER BY created_at DESC, id DESC
               LIMIT $3
             )`,
          [message.endpoint, message.room, config.maxCount],
        );

        await pool.query('COMMIT');
      } catch (err) {
        await pool.query('ROLLBACK').catch(() => {});
        throw err;
      }

      return message;
    },

    async getHistory(endpoint, room, opts) {
      const limit = opts?.limit ?? 50;

      if (opts?.before) {
        // Look up the cursor message's created_at
        const cursorResult = await pool.query<{ created_at: string }>(
          'SELECT created_at FROM ws_messages WHERE id = $1',
          [opts.before],
        );
        if (cursorResult.rows.length === 0) {
          // Cursor not found — return empty
          return [];
        }
        const cursorCreatedAt = cursorResult.rows[0].created_at;

        const result = await pool.query<WsMessageRow>(
          `SELECT id, endpoint, room, sender_id, payload, created_at
           FROM ws_messages
           WHERE endpoint = $1 AND room = $2
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $5`,
          [endpoint, room, cursorCreatedAt, opts.before, limit],
        );
        // Reverse to oldest-first
        return result.rows.reverse().map(rowToMessage);
      }

      if (opts?.after) {
        // Look up the cursor message's created_at
        const cursorResult = await pool.query<{ created_at: string }>(
          'SELECT created_at FROM ws_messages WHERE id = $1',
          [opts.after],
        );
        if (cursorResult.rows.length === 0) {
          return [];
        }
        const cursorCreatedAt = cursorResult.rows[0].created_at;

        const result = await pool.query<WsMessageRow>(
          `SELECT id, endpoint, room, sender_id, payload, created_at
           FROM ws_messages
           WHERE endpoint = $1 AND room = $2
             AND (created_at, id) > ($3, $4)
           ORDER BY created_at ASC, id ASC
           LIMIT $5`,
          [endpoint, room, cursorCreatedAt, opts.after, limit],
        );
        // Already in oldest-first order
        return result.rows.map(rowToMessage);
      }

      // Default: no cursor
      const result = await pool.query<WsMessageRow>(
        `SELECT id, endpoint, room, sender_id, payload, created_at
         FROM ws_messages
         WHERE endpoint = $1 AND room = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [endpoint, room, limit],
      );
      // Reverse to oldest-first
      return result.rows.reverse().map(rowToMessage);
    },

    async clear() {
      try {
        await pool.query('DELETE FROM ws_messages');
      } catch {
        /* best-effort */
      }
    },
  };
}
