import { toCamelCase } from '@lastshotlabs/slingshot-entity';

export interface PostgresQueryHandle {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * The Postgres table backing `Thread`.
 *
 * This was `'slingshot_thread'`, which does not exist and never has. The
 * config-driven adapter derives a Postgres table as
 * `slingshot_<namespace>_<pluralised name>` — `Thread` is namespaced
 * `community`, so the real table is `slingshot_community_threads`. Every
 * handler in this file therefore raised
 * `relation "slingshot_thread" does not exist`, which means
 * `listByContainerSorted` — the operation behind the `new`, `active`, `hot`,
 * `top` and `controversial` sort presets — returned HTTP 500 on Postgres for
 * every consumer, for every preset. It only ever worked on the other backends.
 *
 * Kept as a constant rather than derived via `storageName(Thread, 'postgres')`
 * because importing the entity config here would close an import cycle
 * (`entities/thread.ts` already imports this module). The consequence is that a
 * consumer overriding `storage.postgres.tableName` on `Thread` would still be
 * queried at the default name — narrower than the bug it replaces, and worth
 * revisiting if that override ever ships.
 */
export const THREAD_POSTGRES_TABLE = 'slingshot_community_threads';

export function clampLimit(raw: string | undefined, fallback = 20): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(100, parsed));
}

export function parseCountRow(row: Record<string, unknown> | undefined): number {
  const raw = row?.total;
  return typeof raw === 'number' ? raw : Number(raw ?? 0);
}

export function toCamelRecord(row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    record[toCamelCase(key)] = value;
  }
  return record;
}
