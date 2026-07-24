import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, fromPgRow, op, storageName } from '@lastshotlabs/slingshot-entity';
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
/**
 * The physical Postgres table for `NotificationPreference`, resolved through
 * the same helper the postgres adapter uses so raw SQL cannot drift from the
 * table the adapter provisions (`slingshot_notification_preferences`).
 */
const PG_TABLE = storageName(NotificationPreference, 'postgres');

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
        // The auto-generated sqlite table is `notification_preferences`
        // (snake_case plural) with snake_case columns; map back to the
        // camelCase record shape via `materializePreferenceRecord` since the
        // entity wiring layer does not pass `fromRow` to custom op factories.
        const database = db as {
          query<T>(sql: string): { all(...args: unknown[]): T[] };
        };
        const rows = database
          .query<
            Record<string, unknown>
          >('SELECT * FROM notification_preferences WHERE user_id = ?')
          .all(userId);
        return Promise.resolve(
          rows.map(row =>
            materializePreferenceRecord({
              id: row['id'],
              userId: row['user_id'],
              tenantId: typeof row['tenant_id'] === 'string' ? row['tenant_id'] : null,
              scope: row['scope'],
              source: typeof row['source'] === 'string' ? row['source'] : null,
              type: typeof row['type'] === 'string' ? row['type'] : null,
              muted: row['muted'] === 1 || row['muted'] === true,
              pushEnabled: row['push_enabled'] !== 0 && row['push_enabled'] !== false,
              emailEnabled: row['email_enabled'] !== 0 && row['email_enabled'] !== false,
              inAppEnabled: row['in_app_enabled'] !== 0 && row['in_app_enabled'] !== false,
              quietStart: typeof row['quiet_start'] === 'string' ? row['quiet_start'] : null,
              quietEnd: typeof row['quiet_end'] === 'string' ? row['quiet_end'] : null,
              updatedAt:
                typeof row['updated_at'] === 'number'
                  ? new Date(row['updated_at'] as number)
                  : new Date(0),
            }),
          ),
        );
      },
    postgres:
      pool =>
      async ({ userId }) => {
        const client = pool as {
          query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
        };
        // Same contract as the sqlite branch: the adapter provisions
        // `slingshot_notification_preferences` with snake_case columns, so the
        // raw SQL must use those names and the rows must be mapped back to the
        // camelCase record shape.
        const result = await client.query(
          `SELECT * FROM ${PG_TABLE} WHERE user_id = $1`,
          [userId],
        );
        return result.rows.map(row =>
          materializePreferenceRecord(
            fromPgRow(row as Record<string, unknown>, NotificationPreference.fields),
          ),
        );
      },
    mongo:
      collection =>
      async ({ userId }) => {
        const target = collection as { find(query: unknown): { toArray(): Promise<unknown[]> } };
        return (await target.find({ userId }).toArray()) as NotificationPreferenceRecord[];
      },
  }),
});
