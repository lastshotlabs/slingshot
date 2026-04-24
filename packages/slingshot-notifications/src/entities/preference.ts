import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import type { NotificationPreferenceRecord } from '../types';

function extractMemoryRow(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value['record'];
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : value;
}

function materializePreferenceRecord(row: Record<string, unknown>): NotificationPreferenceRecord {
  return {
    id: String(row.id),
    userId: String(row.userId),
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : null,
    scope: row.scope === 'source' || row.scope === 'type' ? row.scope : 'global',
    source: typeof row.source === 'string' ? row.source : null,
    type: typeof row.type === 'string' ? row.type : null,
    muted: row.muted === true,
    pushEnabled: row.pushEnabled !== false,
    emailEnabled: row.emailEnabled !== false,
    inAppEnabled: row.inAppEnabled !== false,
    quietStart: typeof row.quietStart === 'string' ? row.quietStart : null,
    quietEnd: typeof row.quietEnd === 'string' ? row.quietEnd : null,
    updatedAt:
      row.updatedAt instanceof Date || typeof row.updatedAt === 'string'
        ? row.updatedAt
        : new Date(0),
  };
}

/**
 * Notification preference entity.
 */
export const NotificationPreference = defineEntity('NotificationPreference', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    tenantId: field.string({ optional: true, immutable: true }),
    scope: field.enum(['global', 'source', 'type'] as const, { immutable: true }),
    source: field.string({ optional: true, immutable: true }),
    type: field.string({ optional: true, immutable: true }),
    muted: field.boolean({ default: false }),
    pushEnabled: field.boolean({ default: true }),
    emailEnabled: field.boolean({ default: true }),
    inAppEnabled: field.boolean({ default: true }),
    quietStart: field.string({ optional: true }),
    quietEnd: field.string({ optional: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['userId', 'scope']), index(['userId', 'source']), index(['userId', 'type'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    list: {},
    get: {},
    create: {},
    update: {},
    delete: {},
    operations: {
      listByUser: {},
    },
  },
});

/**
 * Notification preference named operations.
 */
export const notificationPreferenceOperations = defineOperations(NotificationPreference, {
  listByUser: op.lookup({
    fields: { userId: 'param:actor.id' },
    returns: 'many',
  }),

  resolveForNotification: op.custom<
    (args: { userId: string }) => Promise<NotificationPreferenceRecord[]>
  >({
    memory:
      store =>
      ({ userId }) => {
        const rows: NotificationPreferenceRecord[] = [];
        for (const value of store.values()) {
          const row = materializePreferenceRecord(extractMemoryRow(value));
          if (row.userId === userId) rows.push(row);
        }
        return Promise.resolve(rows);
      },
    sqlite:
      db =>
      ({ userId }) => {
        const database = db as { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
        return Promise.resolve(
          database
            .prepare('SELECT * FROM NotificationPreference WHERE userId = ?')
            .all(userId) as NotificationPreferenceRecord[],
        );
      },
    postgres:
      pool =>
      async ({ userId }) => {
        const client = pool as {
          query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
        };
        const result = await client.query(
          'SELECT * FROM "NotificationPreference" WHERE "userId" = $1',
          [userId],
        );
        return result.rows as NotificationPreferenceRecord[];
      },
    mongo:
      collection =>
      async ({ userId }) => {
        const target = collection as { find(query: unknown): { toArray(): Promise<unknown[]> } };
        return (await target.find({ userId }).toArray()) as NotificationPreferenceRecord[];
      },
  }),
});
