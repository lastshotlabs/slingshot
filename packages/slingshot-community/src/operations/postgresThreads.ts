import { toCamelCase } from '@lastshotlabs/slingshot-entity';

export interface PostgresQueryHandle {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export const THREAD_POSTGRES_TABLE = 'slingshot_thread';

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
