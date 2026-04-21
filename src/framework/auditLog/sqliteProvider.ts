import type {
  AuditLogEntry,
  AuditLogProvider,
  RuntimeSqliteDatabase,
} from '@lastshotlabs/slingshot-core';
import { createSqliteInitializer } from '../persistence/sqliteInit';
import { decodeCursorOrThrow, encodeCursor } from './cursor';

const sqliteAuditLogInitializers = new WeakMap<RuntimeSqliteDatabase, () => void>();

function isAuditMeta(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAuditMeta(rawMeta: string | null): Record<string, unknown> | undefined {
  if (!rawMeta) return undefined;
  const parsed: unknown = JSON.parse(rawMeta);
  return isAuditMeta(parsed) ? parsed : undefined;
}

export function ensureSqliteTable(db: RuntimeSqliteDatabase): void {
  let initializer = sqliteAuditLogInitializers.get(db);
  if (!initializer) {
    initializer = createSqliteInitializer(db, () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id         TEXT PRIMARY KEY,
          userId     TEXT,
          sessionId  TEXT,
          tenantId   TEXT,
          method     TEXT NOT NULL,
          path       TEXT NOT NULL,
          status     INTEGER NOT NULL,
          ip         TEXT,
          userAgent  TEXT,
          action     TEXT,
          resource   TEXT,
          resourceId TEXT,
          meta       TEXT,
          createdAt  TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_al_user   ON audit_logs(userId,   createdAt)');
      db.run('CREATE INDEX IF NOT EXISTS idx_al_tenant ON audit_logs(tenantId, createdAt)');
      db.run('CREATE INDEX IF NOT EXISTS idx_al_path   ON audit_logs(path)');
    });
    sqliteAuditLogInitializers.set(db, initializer);
  }
  initializer();
}

export function createSqliteAuditLogProvider(
  db: RuntimeSqliteDatabase,
  ttlDays?: number,
): AuditLogProvider {
  return {
    logEntry(entry) {
      try {
        ensureSqliteTable(db);
        db.run(
          `INSERT INTO audit_logs
             (id, userId, sessionId, tenantId, method, path, status,
              ip, userAgent, action, resource, resourceId, meta, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          entry.meta !== undefined ? JSON.stringify(entry.meta) : null,
          entry.createdAt,
        );
        if (ttlDays !== undefined) {
          const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
          db.run('DELETE FROM audit_logs WHERE createdAt < ?', cutoff);
        }
      } catch (err) {
        console.error('[auditLog] failed to write entry:', err);
      }
      return Promise.resolve();
    },

    getLogs(query) {
      ensureSqliteTable(db);

      const limit = Math.min(query.limit ?? 50, 200);
      const after = query.after ? new Date(query.after).toISOString() : undefined;
      const before = query.before ? new Date(query.before).toISOString() : undefined;
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];

      if (query.userId !== undefined) {
        conditions.push('userId = ?');
        params.push(query.userId);
      }
      if (query.tenantId !== undefined) {
        conditions.push('tenantId = ?');
        params.push(query.tenantId);
      }
      if (after) {
        conditions.push('createdAt >= ?');
        params.push(after);
      }
      if (before) {
        conditions.push('createdAt < ?');
        params.push(before);
      }
      if (query.cursor) {
        const c = decodeCursorOrThrow(query.cursor);
        conditions.push('(createdAt < ? OR (createdAt = ? AND id < ?))');
        params.push(c.t, c.t, c.id);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .query<
          Record<string, unknown>
        >(`SELECT * FROM audit_logs ${where} ORDER BY createdAt DESC, id DESC LIMIT ?`)
        .all(...params, limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items: AuditLogEntry[] = pageRows.map(row => ({
        id: row.id as string,
        userId: (row.userId as string | null) ?? null,
        sessionId: (row.sessionId as string | null) ?? null,
        tenantId: (row.tenantId as string | null) ?? null,
        method: row.method as string,
        path: row.path as string,
        status: row.status as number,
        ip: (row.ip as string | null) ?? null,
        userAgent: (row.userAgent as string | null) ?? null,
        action: (row.action as string | undefined) ?? undefined,
        resource: (row.resource as string | undefined) ?? undefined,
        resourceId: (row.resourceId as string | undefined) ?? undefined,
        meta: parseAuditMeta((row.meta as string | null) ?? null),
        createdAt: row.createdAt as string,
      }));

      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined;
      return Promise.resolve({ items, nextCursor });
    },
  };
}
