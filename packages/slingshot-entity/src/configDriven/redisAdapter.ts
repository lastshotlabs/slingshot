/**
 * Config-driven Redis adapter generator.
 *
 * Records are stored as JSON strings under prefixed keys.
 * Supports TTL, soft-delete, cursor pagination, and tenant scoping.
 */
import type {
  EntityAdapter,
  OperationConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '@lastshotlabs/slingshot-core';
import {
  applyDefaults,
  applyOnUpdate,
  buildCursorForRecord,
  coerceToDate,
  compareForSort,
  decodeCursor,
  fromRedisRecord,
  isSoftDeleted,
  storageName,
  toRedisRecord,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import { buildRedisOperations } from './redisOperationWiring';

/**
 * Create a Redis-backed {@link EntityAdapter} for the given entity config.
 *
 * Records are stored as JSON strings under prefixed keys (default format:
 * `${storageName}:${appName}:${pk}`). Supports TTL expiration, soft-delete,
 * cursor pagination, and tenant-scoped list operations.
 *
 * The key format can be customised via `config._conventions.redisKey`.
 *
 * @param redis - The Redis client instance (must implement {@link RedisLike}).
 * @param appName - The application name, used in the default key prefix.
 * @param config - The resolved entity config with fields, indexes, and conventions.
 * @param operations - Optional named operation configs for the entity.
 * @returns An {@link EntityAdapter} with CRUD methods backed by Redis.
 *
 * @see {@link EntityStorageConventions} for customising the Redis key format.
 */
export function createRedisEntityAdapter<Entity, CreateInput, UpdateInput>(
  redis: RedisLike,
  appName: string,
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  const resolvedStorageName = storageName(config, 'redis');
  const customRedisKey = config._conventions?.redisKey;
  const prefix = `${resolvedStorageName}:${appName}:`;
  const pkField = config._pkField;
  const ttlSeconds = config.ttl?.defaultSeconds;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = config.pagination?.cursor.fields ?? [pkField];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  function rkey(pk: string | number): string {
    if (customRedisKey) {
      return customRedisKey({ appName, storageName: resolvedStorageName, pk });
    }
    return `${prefix}${pk}`;
  }

  async function storeRecord(record: Record<string, unknown>): Promise<void> {
    const pk = record[pkField] as string | number;
    const serialised = JSON.stringify(toRedisRecord(record, config.fields));
    if (ttlSeconds) {
      await redis.set(rkey(pk), serialised, 'EX', ttlSeconds);
    } else {
      await redis.set(rkey(pk), serialised);
    }
  }

  async function loadRecord(pk: string | number): Promise<Record<string, unknown> | null> {
    const raw = await redis.get(rkey(pk));
    if (!raw) return null;
    return fromRedisRecord(JSON.parse(raw) as Record<string, unknown>, config.fields);
  }

  function isVisible(record: Record<string, unknown>): boolean {
    return !isSoftDeleted(record, config);
  }

  function matchesFilter(
    record: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): boolean {
    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (record[key] !== val) return false;
    }
    return true;
  }

  // Derive the scan pattern for key enumeration. For custom key functions,
  // generate a pattern by replacing the PK placeholder with '*'.
  const scanPattern = customRedisKey
    ? customRedisKey({ appName, storageName: resolvedStorageName, pk: '*' })
    : `${prefix}*`;

  async function scanAllKeys(): Promise<string[]> {
    const allKeys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', scanPattern, 'COUNT', 200);
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');
    return allKeys;
  }

  const customAutoDefault = config._conventions?.autoDefault;
  const customOnUpdate = config._conventions?.onUpdate;

  return {
    async create(input) {
      const record = applyDefaults(
        input as Record<string, unknown>,
        config.fields,
        customAutoDefault,
      );
      await storeRecord(record);
      return { ...record } as unknown as Entity;
    },

    async getById(id, filter) {
      const record = await loadRecord(id);
      if (!record || !isVisible(record)) return null;
      if (filter && !matchesFilter(record, filter)) return null;
      return { ...record } as unknown as Entity;
    },

    async update(id, input, filter) {
      const existing = await loadRecord(id);
      if (!existing || !isVisible(existing)) {
        return null;
      }
      if (filter && !matchesFilter(existing, filter)) {
        return null;
      }
      const updatePayload = applyOnUpdate(
        input as Record<string, unknown>,
        config.fields,
        customOnUpdate,
      );
      Object.assign(existing, updatePayload);
      await storeRecord(existing);
      return { ...existing } as unknown as Entity;
    },

    async delete(id, filter) {
      if (config.softDelete) {
        const existing = await loadRecord(id);
        if (!existing || !isVisible(existing)) return false;
        if (filter && !matchesFilter(existing, filter)) return false;
        existing[config.softDelete.field] =
          'value' in config.softDelete ? config.softDelete.value : new Date().toISOString();
        const onUpdateFields = applyOnUpdate({}, config.fields, customOnUpdate);
        Object.assign(existing, onUpdateFields);
        await storeRecord(existing);
        return true;
      } else {
        const existing = await loadRecord(id);
        if (!existing || !isVisible(existing)) return false;
        if (filter && !matchesFilter(existing, filter)) return false;
        await redis.del(rkey(id));
        return true;
      }
    },

    async list(opts) {
      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      const limit = Math.min(rawLimit, maxLimit);
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      const allKeys = await scanAllKeys();
      const records: Array<Record<string, unknown>> = [];

      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>, config.fields);
        if (!isVisible(record)) continue;
        if (filter && !matchesFilter(record, filter)) continue;
        records.push(record);
      }

      records.sort((a, b) => compareForSort(a, b, cursorFields, sortDir));

      // Apply cursor
      let startIdx = 0;
      if (opts?.cursor) {
        const cursorValues = decodeCursor(opts.cursor);
        // Restore dates
        for (const f of cursorFields) {
          if (config.fields[f].type === 'date' && typeof cursorValues[f] === 'string') {
            cursorValues[f] = coerceToDate(cursorValues[f]);
          }
        }
        const cursorIdx = records.findIndex(r => {
          for (const f of cursorFields) {
            const rVal = r[f];
            const cVal = cursorValues[f];
            if (rVal instanceof Date && cVal instanceof Date) {
              if (rVal.getTime() !== cVal.getTime()) return false;
            } else if (rVal !== cVal) return false;
          }
          return true;
        });
        startIdx = cursorIdx >= 0 ? cursorIdx + 1 : 0;
      }

      const page = records.slice(startIdx, startIdx + limit + 1);
      const hasMore = page.length > limit;
      const items = page.slice(0, limit).map(r => ({ ...r }) as unknown as Entity);

      let nextCursor: string | undefined;
      if (hasMore && items.length > 0) {
        nextCursor = buildCursorForRecord(page[limit - 1], cursorFields);
      }

      return { items, nextCursor, hasMore };
    },

    async clear() {
      const allKeys = await scanAllKeys();
      if (allKeys.length > 0) await redis.del(...allKeys);
    },

    ...(operations
      ? buildRedisOperations(operations, config, redis, prefix, scanAllKeys, storeRecord)
      : {}),
  };
}
