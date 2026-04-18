/**
 * Per-backend handler factories for the `searchInContainer` custom operation.
 *
 * Each factory receives the backend-specific store driver and returns an async
 * function that accepts `{ containerId, q?, tag?, authorId?, status?,
 * limit?, cursor? }` as a merged params object (path params + query params
 * merged by `buildBareEntityRoutes`).
 *
 * The memory factory performs substring matching on `title` and `body` fields
 * and supports filtering by `containerId`, `tag` (via `tagIds` JSON array),
 * `authorId`, and `status`. Production backends (SQLite, Postgres, Mongo, Redis)
 * should delegate to the slingshot-search plugin when available, falling back to
 * native DB queries.
 *
 * Used by `threadOperations.searchInContainer` in `src/entities/thread.ts`.
 */
import {
  PostgresQueryHandle,
  THREAD_POSTGRES_TABLE,
  clampLimit,
  parseCountRow,
  toCamelRecord,
} from './postgresThreads';

/** Query parameters for the `searchInContainer` operation. */
export interface SearchInContainerParams {
  readonly containerId: string;
  readonly q?: string;
  readonly tag?: string;
  readonly authorId?: string;
  readonly status?: string;
  readonly limit?: string;
  readonly cursor?: string;
}

/** Paginated result returned by the `searchInContainer` operation. */
export interface SearchInContainerResult {
  readonly items: Array<Record<string, unknown>>;
  readonly total: number;
  readonly nextCursor?: string;
}

function parseCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = parseInt(decoded, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function matchesTagFilter(record: Record<string, unknown>, tag: string): boolean {
  const raw = record.tagIds;
  if (raw == null) return false;
  let tags: unknown[];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      tags = Array.isArray(parsed) ? parsed : [];
    } catch {
      return false;
    }
  } else if (Array.isArray(raw)) {
    tags = raw;
  } else {
    return false;
  }
  return tags.includes(tag);
}

/**
 * Memory-backend handler factory for `searchInContainer`.
 *
 * Performs an in-memory scan of the thread store. Filters by:
 * - `containerId` (required, from path param)
 * - `status` (optional query param)
 * - `authorId` (optional query param)
 * - `tag` (optional query param — checks `tagIds` JSON array)
 * - `q` (optional query param — case-insensitive substring on `title` and `body`)
 *
 * Returns a paginated `{ items, total, nextCursor }` response.
 *
 * @param store - The thread entity's in-memory `Map`.
 * @returns An async handler bound to the provided store.
 */
export function createSearchInContainerMemoryHandler(
  store: Map<string, Record<string, unknown>>,
): (params: SearchInContainerParams) => Promise<SearchInContainerResult> {
  return params => {
    const all = Array.from(store.values()).filter(
      r => r._softDeleted !== true && r._deleted !== true,
    );

    let items = all.filter(r => r.containerId === params.containerId);

    if (params.status) {
      items = items.filter(r => r.status === params.status);
    }
    if (params.authorId) {
      items = items.filter(r => r.authorId === params.authorId);
    }
    if (params.tag) {
      const tag = params.tag;
      items = items.filter(r => matchesTagFilter(r, tag));
    }
    if (params.q) {
      const q = params.q.toLowerCase();
      items = items.filter(r => {
        const title = (typeof r.title === 'string' ? r.title : '').toLowerCase();
        const body = (typeof r.body === 'string' ? r.body : '').toLowerCase();
        return title.includes(q) || body.includes(q);
      });
    }

    // Sort by createdAt descending (most recent first)
    items.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt as string).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt as string).getTime() : 0;
      return bTime - aTime;
    });

    const total = items.length;
    const limit = params.limit ? Math.max(1, Math.min(100, parseInt(params.limit, 10))) : 20;
    const offset = parseCursorOffset(params.cursor);
    const page = items.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? encodeCursorOffset(offset + limit) : undefined;

    return Promise.resolve({ items: page, total, nextCursor });
  };
}

/**
 * SQLite-backend handler factory for `searchInContainer`.
 *
 * Production implementation should use SQLite FTS5 or a LIKE query.
 * Returns empty results as a stub — wire the full implementation when
 * deploying against a SQLite database.
 *
 * @param _db - SQLite database handle (unused in stub).
 */
export function createSearchInContainerSqliteHandler(
  _db: unknown,
): (params: SearchInContainerParams) => Promise<SearchInContainerResult> {
  void _db;
  return () => Promise.resolve({ items: [], total: 0 });
}

/**
 * Postgres-backend handler factory for `searchInContainer`.
 *
 * Uses native Postgres filtering with `ILIKE` matching on `title` / `body`
 * and JSONB containment for `tagIds`.
 *
 * @param pool - Postgres connection pool.
 */
export function createSearchInContainerPostgresHandler(
  pool: unknown,
): (params: SearchInContainerParams) => Promise<SearchInContainerResult> {
  const client = pool as PostgresQueryHandle;

  return async params => {
    const conditions = ['container_id = $1'];
    const values: unknown[] = [params.containerId];
    let paramIdx = 2;

    if (params.status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(params.status);
    }
    if (params.authorId) {
      conditions.push(`author_id = $${paramIdx++}`);
      values.push(params.authorId);
    }
    if (params.tag) {
      conditions.push(`tag_ids @> $${paramIdx++}::jsonb`);
      values.push(JSON.stringify([params.tag]));
    }
    if (params.q) {
      conditions.push(`(title ILIKE $${paramIdx} OR COALESCE(body, '') ILIKE $${paramIdx})`);
      values.push(`%${params.q}%`);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');
    const totalResult = await client.query(
      `SELECT COUNT(*) AS total FROM ${THREAD_POSTGRES_TABLE} WHERE ${whereClause}`,
      values,
    );
    const total = parseCountRow(totalResult.rows[0]);

    const limit = clampLimit(params.limit);
    const offset = parseCursorOffset(params.cursor);
    const pageValues = [...values, limit, offset];
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx}`;
    const result = await client.query(
      `SELECT * FROM ${THREAD_POSTGRES_TABLE}
       WHERE ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      pageValues,
    );

    const items = result.rows.map(toCamelRecord);
    const nextCursor = offset + limit < total ? encodeCursorOffset(offset + limit) : undefined;
    return { items, total, nextCursor };
  };
}

/**
 * MongoDB-backend handler factory for `searchInContainer`.
 *
 * Production implementation should use MongoDB `$text` queries or the
 * slingshot-search Atlas Search integration.
 * Returns empty results as a stub.
 *
 * @param _collection - Mongoose model / collection handle (unused in stub).
 */
export function createSearchInContainerMongoHandler(
  _collection: unknown,
): (params: SearchInContainerParams) => Promise<SearchInContainerResult> {
  void _collection;
  return () => Promise.resolve({ items: [], total: 0 });
}

/**
 * Redis-backend handler factory for `searchInContainer`.
 *
 * Production implementation should delegate to the slingshot-search plugin.
 * Returns empty results as a stub.
 *
 * @param _redis - Redis client handle (unused in stub).
 */
export function createSearchInContainerRedisHandler(
  _redis: unknown,
): (params: SearchInContainerParams) => Promise<SearchInContainerResult> {
  void _redis;
  return () => Promise.resolve({ items: [], total: 0 });
}
