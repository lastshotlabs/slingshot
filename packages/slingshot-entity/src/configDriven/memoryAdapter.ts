/**
 * Config-driven memory adapter generator.
 *
 * Produces an EntityAdapter backed by an in-memory Map with LRU eviction,
 * optional TTL, soft-delete, cursor pagination, and tenant scoping.
 */
import type {
  EntityAdapter,
  OperationConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import { createEvictExpired, evictOldest } from '@lastshotlabs/slingshot-core';
import {
  applyDefaults,
  applyOnUpdate,
  buildCursorForRecord,
  coerceToDate,
  compareForSort,
  decodeCursor,
  isSoftDeleted,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import { buildMemoryOperations } from './memoryOperationWiring';
import type { MemoryEntry } from './operationExecutors/dbInterfaces';

/**
 * Create an in-memory EntityAdapter for the given entity config.
 *
 * - Stores records in a `Map` keyed by primary key
 * - Supports TTL via per-entry `expiresAt`
 * - Soft-delete: sets the configured field instead of removing
 * - Cursor pagination using cursor field values
 * - Tenant scoping in list operations
 */
export function createMemoryEntityAdapter<Entity, CreateInput, UpdateInput>(
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  const store = new Map<string | number, MemoryEntry>();
  const evictExpired = createEvictExpired();
  const pkField = config._pkField;
  const maxEntries = config.storage?.memory?.maxEntries ?? 10_000;
  const ttlMs = config.ttl ? config.ttl.defaultSeconds * 1000 : undefined;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = config.pagination?.cursor.fields ?? [pkField];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  /**
   * Check whether a store entry has not yet expired.
   *
   * @param entry - The store entry to test.
   * @returns `true` if the entry has no TTL or its `expiresAt` timestamp is
   *   in the future; `false` if it has expired and should be evicted.
   */
  function isAlive(entry: MemoryEntry): boolean {
    if (!entry.expiresAt) return true;
    return Date.now() < entry.expiresAt;
  }

  /**
   * Check whether a record should be returned to callers (i.e. it is not
   * soft-deleted according to the entity's configured strategy).
   *
   * @param record - The raw entity record from the in-memory store.
   * @returns `true` if the record is live and should be visible; `false` if it
   *   has been soft-deleted.
   */
  function recordVisible(record: Record<string, unknown>): boolean {
    return !isSoftDeleted(record, config);
  }

  /**
   * Test whether a record matches all non-pagination fields in a filter object.
   *
   * Pagination-reserved keys (`limit`, `cursor`, `sortDir`) and `undefined`
   * values are skipped. Any field with a defined value in `filter` must be
   * strictly equal to the corresponding field in `record`.
   *
   * @param record - The entity record to test.
   * @param filter - A flat key/value map of field constraints.
   * @returns `true` if the record satisfies every active filter constraint.
   */
  function matchesFilter(
    record: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): boolean {
    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      // Skip pagination keys
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (record[key] !== val) return false;
    }
    return true;
  }

  /**
   * Decode an opaque cursor string and restore typed values for cursor fields.
   *
   * After base64url-decoding the cursor JSON, `date`-typed cursor fields are
   * converted from their ISO-string representation back to `Date` objects via
   * `coerceToDate`. This ensures `isAfterCursor` comparisons work correctly
   * regardless of the cursor's serialised form.
   *
   * @param cursor - An opaque cursor string previously produced by
   *   `buildCursorForRecord`.
   * @returns A map of cursor field names to their correctly-typed values.
   */
  function parseCursorValues(cursor: string): Record<string, unknown> {
    const raw = decodeCursor(cursor);
    // Restore Date fields
    for (const f of cursorFields) {
      if (config.fields[f].type === 'date' && typeof raw[f] === 'string') {
        raw[f] = coerceToDate(raw[f]);
      }
    }
    return raw;
  }

  return {
    create(input) {
      evictOldest(store, maxEntries);
      if (ttlMs) evictExpired(store);

      const record = applyDefaults(input as Record<string, unknown>, config.fields);
      const pk = record[pkField] as string | number;

      store.set(pk, {
        record,
        expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
      });

      return Promise.resolve({ ...record } as unknown as Entity);
    },

    getById(id, filter) {
      const entry = store.get(id);
      if (!entry || !isAlive(entry)) {
        if (entry) store.delete(id);
        return Promise.resolve(null);
      }
      if (!recordVisible(entry.record)) return Promise.resolve(null);
      if (filter && !matchesFilter(entry.record, filter)) return Promise.resolve(null);
      return Promise.resolve({ ...entry.record } as unknown as Entity);
    },

    update(id, input, filter) {
      const entry = store.get(id);
      if (!entry || !isAlive(entry)) {
        if (entry) store.delete(id);
        return Promise.resolve(null);
      }
      if (!recordVisible(entry.record)) {
        return Promise.resolve(null);
      }
      if (filter && !matchesFilter(entry.record, filter)) {
        return Promise.resolve(null);
      }

      const updatePayload = applyOnUpdate(input as Record<string, unknown>, config.fields);
      Object.assign(entry.record, updatePayload);

      // Refresh TTL on update
      if (ttlMs) entry.expiresAt = Date.now() + ttlMs;

      return Promise.resolve({ ...entry.record } as unknown as Entity);
    },

    delete(id, filter) {
      const entry = store.get(id);
      if (!entry || !isAlive(entry)) {
        if (entry) store.delete(id);
        return Promise.resolve(false);
      }
      if (!recordVisible(entry.record)) {
        return Promise.resolve(false);
      }
      if (filter && !matchesFilter(entry.record, filter)) {
        return Promise.resolve(false);
      }

      if (config.softDelete) {
        // Soft delete: set the status field
        entry.record[config.softDelete.field] =
          'value' in config.softDelete ? config.softDelete.value : new Date().toISOString();
        // Apply onUpdate fields (e.g. updatedAt)
        const onUpdateFields = applyOnUpdate({}, config.fields);
        Object.assign(entry.record, onUpdateFields);
      } else {
        store.delete(id);
      }
      return Promise.resolve(true);
    },

    list(opts) {
      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      const limit = Math.min(rawLimit, maxLimit);
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      // Collect visible records
      const visible: Array<Record<string, unknown>> = [];
      for (const [pk, entry] of store) {
        if (!isAlive(entry)) {
          store.delete(pk);
          continue;
        }
        if (!recordVisible(entry.record)) continue;
        if (filter && !matchesFilter(entry.record, filter)) continue;
        visible.push(entry.record);
      }

      // Sort
      visible.sort((a, b) => compareForSort(a, b, cursorFields, sortDir));

      // Apply cursor
      let startIdx = 0;
      if (opts?.cursor) {
        const cursorValues = parseCursorValues(opts.cursor);
        // Skip records up to and including the cursor position
        const cursorIdx = visible.findIndex(r => {
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

      const page = visible.slice(startIdx, startIdx + limit + 1);
      const hasMore = page.length > limit;
      const items = page.slice(0, limit).map(r => ({ ...r }) as unknown as Entity);

      let nextCursor: string | undefined;
      if (hasMore && items.length > 0) {
        const lastRecord = page[limit - 1];
        nextCursor = buildCursorForRecord(lastRecord, cursorFields);
      }

      return Promise.resolve({ items, nextCursor, hasMore });
    },

    clear() {
      store.clear();
      return Promise.resolve();
    },

    // Operation methods (if any)
    ...(operations
      ? buildMemoryOperations(operations, config, store, isAlive, recordVisible, {
          pkField,
          cursorFields,
          defaultSortDir,
          defaultLimit,
          maxLimit,
          ttlMs,
        })
      : {}),
  };
}
