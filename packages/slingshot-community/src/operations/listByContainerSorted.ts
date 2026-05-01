/**
 * Per-backend handler factories for the `listByContainerSorted` custom operation.
 *
 * Each factory receives the backend-specific store driver and returns an async
 * handler that accepts `{ containerId, sort?, window?, limit?, cursor? }`.
 *
 * Sort presets:
 * - `new`           — `createdAt DESC` (default)
 * - `active`        — `lastActivityAt DESC`
 * - `hot`           — `score DESC, createdAt DESC` (score carries hot-decay when
 *                     `config.scoring.algorithm === 'hot'`)
 * - `top`           — `score DESC` filtered by time window
 * - `controversial` — `score DESC` with time window filter (score computed with
 *                     `controversial` algorithm)
 *
 * Window parameter (`24h | 7d | 30d | all`): only meaningful for `top` and
 * `controversial`. Defaults to `all` when omitted.
 */
import {
  PostgresQueryHandle,
  THREAD_POSTGRES_TABLE,
  clampLimit,
  parseCountRow,
  toCamelRecord,
} from './postgresThreads';

type SortPreset = 'new' | 'active' | 'hot' | 'top' | 'controversial';
type WindowPreset = '24h' | '7d' | '30d' | 'all';

/** Query parameters for the `listByContainerSorted` operation. */
export interface ListSortedParams {
  readonly containerId: string;
  readonly sort?: string;
  readonly window?: string;
  readonly limit?: string;
  readonly cursor?: string;
}

/** Paginated result returned by the `listByContainerSorted` operation. */
export interface ListSortedResult {
  readonly items: Array<Record<string, unknown>>;
  readonly total: number;
  readonly nextCursor?: string;
}

function windowToMs(w: WindowPreset): number | null {
  switch (w) {
    case '24h':
      return 86_400_000;
    case '7d':
      return 604_800_000;
    case '30d':
      return 2_592_000_000;
    case 'all':
      return null;
  }
}

function toSortPreset(raw: string | undefined): SortPreset {
  if (
    raw === 'new' ||
    raw === 'active' ||
    raw === 'hot' ||
    raw === 'top' ||
    raw === 'controversial'
  ) {
    return raw;
  }
  return 'new';
}

function toWindowPreset(raw: string | undefined): WindowPreset {
  if (raw === '24h' || raw === '7d' || raw === '30d') return raw;
  return 'all';
}

function parseCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = parseInt(decoded, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    // Malformed cursor; default to offset 0
    return 0;
  }
}

function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function isPublishedRecord(record: Record<string, unknown>): boolean {
  return record.status === undefined || record.status === 'published';
}

/**
 * Memory-backend handler factory for `listByContainerSorted`.
 *
 * Applies sort preset and optional time-window filter directly against the
 * in-memory thread store.
 *
 * @param store - The thread entity's in-memory `Map`.
 * @returns An async handler bound to the provided store.
 */
export function createListSortedMemoryHandler(
  store: Map<string, Record<string, unknown>>,
): (params: ListSortedParams) => Promise<ListSortedResult> {
  return params => {
    const sortPreset = toSortPreset(params.sort);
    const windowPreset = toWindowPreset(params.window);

    const all = Array.from(store.values()).filter(
      r => r._softDeleted !== true && r._deleted !== true,
    );

    let items = all.filter(r => r.containerId === params.containerId && isPublishedRecord(r));

    // Apply time-window filter for top/controversial
    if (sortPreset === 'top' || sortPreset === 'controversial') {
      const windowMs = windowToMs(windowPreset);
      if (windowMs !== null) {
        const cutoff = Date.now() - windowMs;
        items = items.filter(r => {
          const createdAt = r.createdAt as string | Date | undefined;
          if (!createdAt) return false;
          return new Date(createdAt).getTime() >= cutoff;
        });
      }
    }

    // Apply sort
    switch (sortPreset) {
      case 'new':
        items.sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt as string).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt as string).getTime() : 0;
          return bTime - aTime;
        });
        break;

      case 'active':
        items.sort((a, b) => {
          const aVal = (a.lastActivityAt ?? a.createdAt) as string | undefined;
          const bVal = (b.lastActivityAt ?? b.createdAt) as string | undefined;
          const aTime = aVal ? new Date(aVal).getTime() : 0;
          const bTime = bVal ? new Date(bVal).getTime() : 0;
          return bTime - aTime;
        });
        break;

      case 'hot':
        items.sort((a, b) => {
          const aScore = (a.score as number | undefined) ?? 0;
          const bScore = (b.score as number | undefined) ?? 0;
          if (bScore !== aScore) return bScore - aScore;
          // Secondary: newest first
          const aTime = a.createdAt ? new Date(a.createdAt as string).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt as string).getTime() : 0;
          return bTime - aTime;
        });
        break;

      case 'top':
      case 'controversial':
        items.sort((a, b) => {
          const aScore = (a.score as number | undefined) ?? 0;
          const bScore = (b.score as number | undefined) ?? 0;
          return bScore - aScore;
        });
        break;
    }

    const total = items.length;
    const limit = params.limit ? Math.max(1, Math.min(100, parseInt(params.limit, 10))) : 20;
    const offset = parseCursorOffset(params.cursor);
    const page = items.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? encodeCursorOffset(offset + limit) : undefined;

    return Promise.resolve({ items: page, total, nextCursor });
  };
}

/**
 * SQLite-backend handler factory for `listByContainerSorted`.
 *
 * Production implementation should map preset → `ORDER BY` clause and apply
 * the window filter. Returns empty results as a stub.
 *
 * @param _db - SQLite database handle (unused in stub).
 */
export function createListSortedSqliteHandler(
  _db: unknown,
): (params: ListSortedParams) => Promise<ListSortedResult> {
  void _db;
  return () => Promise.resolve({ items: [], total: 0 });
}

/**
 * Postgres-backend handler factory for `listByContainerSorted`.
 *
 * Production: map preset → `ORDER BY` clause; apply window filter via
 * `WHERE created_at > NOW() - INTERVAL '...'`. Returns empty results as a stub.
 *
 * @param _pool - Postgres pool (unused in stub).
 */
export function createListSortedPostgresHandler(
  pool: unknown,
): (params: ListSortedParams) => Promise<ListSortedResult> {
  const client = pool as PostgresQueryHandle;

  return async params => {
    const sortPreset = toSortPreset(params.sort);
    const windowPreset = toWindowPreset(params.window);
    const conditions = ['container_id = $1', "status = 'published'"];
    const values: unknown[] = [params.containerId];
    let paramIdx = 2;

    if (sortPreset === 'top' || sortPreset === 'controversial') {
      const windowMs = windowToMs(windowPreset);
      if (windowMs !== null) {
        conditions.push(`created_at >= $${paramIdx++}`);
        values.push(new Date(Date.now() - windowMs));
      }
    }

    const whereClause = conditions.join(' AND ');
    const orderBy =
      sortPreset === 'active'
        ? 'COALESCE(last_activity_at, created_at) DESC, created_at DESC, id DESC'
        : sortPreset === 'hot'
          ? 'score DESC, created_at DESC, id DESC'
          : sortPreset === 'top' || sortPreset === 'controversial'
            ? 'score DESC, created_at DESC, id DESC'
            : 'created_at DESC, id DESC';

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
       ORDER BY ${orderBy}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      pageValues,
    );

    const items = result.rows.map(toCamelRecord);
    const nextCursor = offset + limit < total ? encodeCursorOffset(offset + limit) : undefined;
    return { items, total, nextCursor };
  };
}

/**
 * MongoDB-backend handler factory for `listByContainerSorted`.
 *
 * Production: map preset → MongoDB `sort` + optional `$gte` date filter.
 * Returns empty results as a stub.
 *
 * @param _collection - Mongoose model (unused in stub).
 */
export function createListSortedMongoHandler(
  _collection: unknown,
): (params: ListSortedParams) => Promise<ListSortedResult> {
  void _collection;
  return () => Promise.resolve({ items: [], total: 0 });
}

/**
 * Redis-backend handler factory for `listByContainerSorted`.
 *
 * Production: use a sorted set per container keyed by algorithm score.
 * Returns empty results as a stub.
 *
 * @param _redis - Redis client (unused in stub).
 */
export function createListSortedRedisHandler(
  _redis: unknown,
): (params: ListSortedParams) => Promise<ListSortedResult> {
  void _redis;
  return () => Promise.resolve({ items: [], total: 0 });
}
