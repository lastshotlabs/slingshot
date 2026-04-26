import { DEFAULT_MAX_ENTRIES, evictOldestArray } from '@lastshotlabs/slingshot-core';
import type { AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { decodeCursorOrThrow, encodeCursor } from './cursor';

export interface MemoryAuditLogProviderOptions {
  emitWarnings?: boolean;
}

export function createMemoryAuditLogProvider(
  options: MemoryAuditLogProviderOptions = {},
): AuditLogProvider {
  const memoryLogs: AuditLogEntry[] = [];
  let evictedEntries = 0;
  let hasWarnedAboutTruncation = false;
  const emitWarnings = options.emitWarnings !== false;

  if (emitWarnings) {
    console.warn(
      `[slingshot] Memory adapter for audit log is capped at ${DEFAULT_MAX_ENTRIES} entries and has no eviction — for development/testing only`,
    );
  }

  return {
    logEntry(entry) {
      try {
        memoryLogs.push(entry);
        if (memoryLogs.length > DEFAULT_MAX_ENTRIES) {
          evictedEntries += memoryLogs.length - DEFAULT_MAX_ENTRIES;
          if (emitWarnings) {
            console.warn(
              `[auditLog] Memory audit log reached ${DEFAULT_MAX_ENTRIES} entries — evicting oldest. Tests relying on audit log completeness may see missing entries.`,
            );
          }
        }
        evictOldestArray(memoryLogs, DEFAULT_MAX_ENTRIES);
      } catch (err) {
        console.error('[auditLog] failed to write entry:', err);
      }
      return Promise.resolve();
    },

    getLogs(query) {
      const limit = Math.min(query.limit ?? 50, 200);
      const after = query.after ? new Date(query.after).toISOString() : undefined;
      const before = query.before ? new Date(query.before).toISOString() : undefined;

      if (emitWarnings && evictedEntries > 0 && !hasWarnedAboutTruncation) {
        hasWarnedAboutTruncation = true;
        console.warn(
          `[auditLog] Memory audit log query is reading a truncated store. ${evictedEntries} oldest entr${evictedEntries === 1 ? 'y was' : 'ies were'} evicted after hitting the ${DEFAULT_MAX_ENTRIES}-entry cap.`,
        );
      }

      let filtered = memoryLogs.slice();
      if (query.userId !== undefined) filtered = filtered.filter(e => e.userId === query.userId);
      if (query.requestTenantId !== undefined)
        filtered = filtered.filter(e => e.requestTenantId === query.requestTenantId);
      if (after) filtered = filtered.filter(e => e.createdAt >= after);
      if (before) filtered = filtered.filter(e => e.createdAt < before);
      filtered.sort((a, b) =>
        a.createdAt < b.createdAt
          ? 1
          : a.createdAt > b.createdAt
            ? -1
            : a.id < b.id
              ? 1
              : a.id > b.id
                ? -1
                : 0,
      );
      if (query.cursor) {
        const c = decodeCursorOrThrow(query.cursor);
        filtered = filtered.filter(e => e.createdAt < c.t || (e.createdAt === c.t && e.id < c.id));
      }

      const page = filtered.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const items = hasMore ? page.slice(0, limit) : page;
      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined;
      return Promise.resolve({ items, nextCursor });
    },
  };
}
