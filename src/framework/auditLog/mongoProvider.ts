import { getAuditLogModel } from '@framework/models/AuditLog';
import type { Connection } from 'mongoose';
import { HttpError } from '@lastshotlabs/slingshot-core';
import type { AuditLogEntry, AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { decodeCursor, encodeCursor } from './cursor';

export function createMongoAuditLogProvider(conn: Connection, ttlDays?: number): AuditLogProvider {
  const AuditLog = getAuditLogModel(conn);

  return {
    async logEntry(entry) {
      try {
        const expiresAt =
          ttlDays !== undefined ? new Date(Date.now() + ttlDays * 86_400_000) : undefined;
        await AuditLog.create({
          ...entry,
          createdAt: new Date(entry.createdAt),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
      } catch (err) {
        console.error('[auditLog] failed to write entry:', err);
      }
    },

    async getLogs(query) {
      const limit = Math.min(query.limit ?? 50, 200);
      const after = query.after ? new Date(query.after).toISOString() : undefined;
      const before = query.before ? new Date(query.before).toISOString() : undefined;
      const filter: Record<string, unknown> = {};

      if (query.userId !== undefined) filter.userId = query.userId;
      if (query.tenantId !== undefined) filter.tenantId = query.tenantId;

      // Build date constraints as independent $and clauses so before and cursor
      // can coexist without one silently overwriting the other.
      const andConditions: Record<string, unknown>[] = [];
      if (after) andConditions.push({ createdAt: { $gte: new Date(after) } });
      if (before) andConditions.push({ createdAt: { $lt: new Date(before) } });
      if (query.cursor) {
        const c = decodeCursor(query.cursor);
        if (!c) throw new HttpError(400, 'Invalid pagination cursor');
        const cursorDate = new Date(c.t);
        andConditions.push({
          $or: [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, id: { $lt: c.id } }],
        });
      }
      if (andConditions.length > 0) filter.$and = andConditions;

      const docs = await AuditLog.find(filter)
        .sort({ createdAt: -1, id: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const items: AuditLogEntry[] = (pageDocs as unknown as Array<Record<string, unknown>>).map(
        doc => ({
          id: doc.id as string,
          userId: (doc.userId as string | null) ?? null,
          sessionId: (doc.sessionId as string | null) ?? null,
          tenantId: (doc.tenantId as string | null) ?? null,
          method: doc.method as string,
          path: doc.path as string,
          status: doc.status as number,
          ip: (doc.ip as string | null) ?? null,
          userAgent: (doc.userAgent as string | null) ?? null,
          action: doc.action as string | undefined,
          resource: doc.resource as string | undefined,
          resourceId: doc.resourceId as string | undefined,
          meta: doc.meta as Record<string, unknown> | undefined,
          createdAt: (doc.createdAt as Date).toISOString(),
        }),
      );

      const last = items.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined;
      return { items, nextCursor };
    },
  };
}
