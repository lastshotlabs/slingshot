import { HttpError } from '@lastshotlabs/slingshot-core';
import type { AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { decodeCursor, encodeCursor } from './cursor';
import { createPostgresInitializer } from '../persistence/postgresInit';

type PgPool = {
  connect(): Promise<{
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
    release(): void;
  }>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

function toCreatedAtIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('[auditLog] Invalid created_at value returned from Postgres');
}

export function createPostgresAuditLogProvider(pool: PgPool, ttlDays?: number): AuditLogProvider {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_audit_logs (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        session_id  TEXT,
        tenant_id   TEXT,
        method      TEXT NOT NULL,
        path        TEXT NOT NULL,
        status      INTEGER NOT NULL,
        ip          TEXT,
        user_agent  TEXT,
        action      TEXT,
        resource    TEXT,
        resource_id TEXT,
        meta        JSONB,
        created_at  TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_bal_user   ON slingshot_audit_logs(user_id,   created_at)',
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_bal_tenant ON slingshot_audit_logs(tenant_id, created_at)',
    );
    await client.query('CREATE INDEX IF NOT EXISTS idx_bal_path   ON slingshot_audit_logs(path)');
  });

  return {
    async logEntry(entry) {
      try {
        await ensureTable();
        await pool.query(
          `INSERT INTO slingshot_audit_logs
             (id, user_id, session_id, tenant_id, method, path, status,
              ip, user_agent, action, resource, resource_id, meta, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.userId ?? null,
            entry.sessionId ?? null,
            entry.tenantId ?? null,
            entry.method,
            entry.path,
            entry.status,
            entry.ip ?? null,
            entry.userAgent ?? null,
            entry.action ?? null,
            entry.resource ?? null,
            entry.resourceId ?? null,
            entry.meta !== undefined ? entry.meta : null,
            entry.createdAt,
          ],
        );
        if (ttlDays !== undefined) {
          const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
          await pool.query('DELETE FROM slingshot_audit_logs WHERE created_at < $1', [cutoff]);
        }
      } catch (err) {
        console.error('[auditLog] failed to write entry:', err);
      }
    },

    async getLogs(query) {
      await ensureTable();
      const limit = Math.min(query.limit ?? 50, 200);
      const conditions: string[] = [];
      const params: unknown[] = [];
      let n = 1;

      if (query.userId !== undefined) {
        conditions.push(`user_id = $${n++}`);
        params.push(query.userId);
      }
      if (query.tenantId !== undefined) {
        conditions.push(`tenant_id = $${n++}`);
        params.push(query.tenantId);
      }
      if (query.after) {
        conditions.push(`created_at >= $${n++}`);
        params.push(new Date(query.after).toISOString());
      }
      if (query.before) {
        conditions.push(`created_at < $${n++}`);
        params.push(new Date(query.before).toISOString());
      }
      if (query.cursor) {
        const c = decodeCursor(query.cursor);
        if (!c) throw new HttpError(400, 'Invalid pagination cursor');
        conditions.push(`(created_at < $${n} OR (created_at = $${n + 1} AND id < $${n + 2}))`);
        params.push(c.t, c.t, c.id);
        n += 3;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT * FROM slingshot_audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT $${n}`,
        [...params, limit + 1],
      );

      const hasMore = result.rows.length > limit;
      const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const items: AuditLogEntry[] = pageRows.map(row => ({
        id: row['id'] as string,
        userId: (row['user_id'] as string | null) ?? null,
        sessionId: (row['session_id'] as string | null) ?? null,
        tenantId: (row['tenant_id'] as string | null) ?? null,
        method: row['method'] as string,
        path: row['path'] as string,
        status: row['status'] as number,
        ip: (row['ip'] as string | null) ?? null,
        userAgent: (row['user_agent'] as string | null) ?? null,
        action: (row['action'] as string | null) ?? undefined,
        resource: (row['resource'] as string | null) ?? undefined,
        resourceId: (row['resource_id'] as string | null) ?? undefined,
        meta: (row['meta'] as Record<string, unknown> | null) ?? undefined,
        createdAt: toCreatedAtIso(row['created_at']),
      }));

      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined;
      return { items, nextCursor };
    },
  };
}
