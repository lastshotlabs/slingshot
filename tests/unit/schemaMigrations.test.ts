import { describe, expect, it } from 'bun:test';
import { defineEntity, field, index } from '../../packages/slingshot-entity/src';
import {
  diffEntityConfig,
  generateInitialMigrationPostgres,
  generateMigrationMongo,
  generateMigrationPostgres,
  generateMigrationSqlite,
  generateMigrations,
  setPostgresTenantContext,
} from '../../packages/slingshot-entity/src/migrations';

// ---------------------------------------------------------------------------
// Base entity for diffing
// ---------------------------------------------------------------------------

const MessageV1 = defineEntity('Message', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string(),
    content: field.string(),
    status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
  softDelete: { field: 'status', value: 'deleted' },
});

// ---------------------------------------------------------------------------
// Diff tests
// ---------------------------------------------------------------------------

describe('diffEntityConfig', () => {
  it('detects no changes for identical configs', () => {
    const plan = diffEntityConfig(MessageV1, MessageV1);
    expect(plan.changes.length).toBe(0);
    expect(plan.hasBreakingChanges).toBe(false);
  });

  it('detects added field', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        priority: field.integer({ default: 0 }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const addField = plan.changes.find(c => c.type === 'addField' && c.name === 'priority');
    expect(addField).toBeDefined();
    expect(plan.hasBreakingChanges).toBe(false);
  });

  it('detects removed field', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const removeField = plan.changes.find(c => c.type === 'removeField' && c.name === 'content');
    expect(removeField).toBeDefined();
  });

  it('emits an explicit data-preserving field rename', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        body: field.string({ renameFrom: 'content' }),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    expect(plan.changes.filter(change => change.type === 'renameField')).toEqual([
      expect.objectContaining({ from: 'content', to: 'body' }),
    ]);
    expect(generateMigrationPostgres(plan)).toContain('RENAME COLUMN "content" TO "body"');
    expect(generateMigrationSqlite(plan)).toContain('RENAME COLUMN "content" TO "body"');
  });

  it('rejects a rename and type change without an explicit transform', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        body: field.integer({ renameFrom: 'content' }),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
    });
    expect(() => diffEntityConfig(MessageV1, v2)).toThrow('without migrationTransform');
  });

  it('models required-field contraction as backfill-gated work', () => {
    const previous = defineEntity('Profile', {
      fields: {
        id: field.string({ primary: true }),
        nickname: field.string({ optional: true }),
      },
    });
    const current = defineEntity('Profile', {
      fields: {
        id: field.string({ primary: true }),
        nickname: field.string(),
      },
    });
    const plan = diffEntityConfig(previous, current);
    expect(plan.hasBreakingChanges).toBe(true);
    expect(plan.changes).toContainEqual({
      type: 'changeOptionality',
      name: 'nickname',
      fromOptional: true,
      toOptional: false,
    });
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain('REQUIRED BACKFILL CHECK');
    expect(sql).toContain('-- ALTER TABLE');
  });

  it('detects field type change as breaking', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.integer(), // was string
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const typeChange = plan.changes.find(c => c.type === 'changeFieldType' && c.name === 'content');
    expect(typeChange).toBeDefined();
    expect(plan.hasBreakingChanges).toBe(true);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('detects added index', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' }), index(['status'])],
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const addIndex = plan.changes.find(c => c.type === 'addIndex');
    expect(addIndex).toBeDefined();
  });

  it('detects removed index', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      softDelete: { field: 'status', value: 'deleted' },
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const removeIndex = plan.changes.find(c => c.type === 'removeIndex');
    expect(removeIndex).toBeDefined();
  });

  it('throws on PK change', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        newId: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      softDelete: { field: 'status', value: 'deleted' },
    });
    expect(() => diffEntityConfig(MessageV1, v2)).toThrow('Primary key changed');
  });

  it('detects soft-delete config change', () => {
    const v2 = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
      // softDelete removed
    });
    const plan = diffEntityConfig(MessageV1, v2);
    const sdChange = plan.changes.find(c => c.type === 'changeSoftDelete');
    expect(sdChange).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Migration generation tests
// ---------------------------------------------------------------------------

describe('Migration SQL generation', () => {
  it('binds PostgreSQL RLS identity transaction-locally', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    await setPostgresTenantContext(
      {
        query: async (sql, values) => {
          calls.push({ sql, values });
        },
      },
      'tenant-a',
    );
    expect(calls).toEqual([
      {
        sql: `SELECT set_config('slingshot.tenant_id', $1, true)`,
        values: ['tenant-a'],
      },
    ]);
    await expect(setPostgresTenantContext({ query: async () => undefined }, '   ')).rejects.toThrow(
      'non-empty tenantId',
    );
  });

  it('generates PostgreSQL tenant RLS policy and verification guidance', () => {
    const entity = defineEntity('TenantDocument', {
      fields: {
        id: field.string({ primary: true }),
        tenantId: field.string(),
      },
      tenant: { field: 'tenantId', postgresRls: true },
    });
    const ddl = generateInitialMigrationPostgres(entity);
    expect(ddl).toContain('ENABLE ROW LEVEL SECURITY');
    expect(ddl).toContain('FORCE ROW LEVEL SECURITY');
    expect(ddl).toContain("current_setting('slingshot.tenant_id', true)");
    expect(ddl).toContain('pg_policies');
  });

  const v2 = defineEntity('Message', {
    namespace: 'chat',
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      roomId: field.string(),
      content: field.string(),
      status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
      priority: field.integer({ default: 0 }),
      tags: field.json({ optional: true }),
      createdAt: field.date({ default: 'now' }),
    },
    indexes: [index(['roomId', 'createdAt'], { direction: 'desc' }), index(['priority'])],
    softDelete: { field: 'status', value: 'deleted' },
  });

  it('generates SQLite migration', () => {
    const plan = diffEntityConfig(MessageV1, v2);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toContain('ALTER TABLE');
    expect(sql).toContain('priority');
    expect(sql).toContain('CREATE INDEX');
    expect(sql).toContain('chat_messages');
  });

  it('generates Postgres migration', () => {
    const plan = diffEntityConfig(MessageV1, v2);
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('COMMIT');
    expect(sql).toContain('ALTER TABLE');
    expect(sql).toContain('priority');
    expect(sql).toContain('CREATE INDEX');
  });

  it('keeps Postgres transaction boundaries outside editable schema/index sections', () => {
    const plan = diffEntityConfig(MessageV1, v2);
    const sql = generateMigrationPostgres(plan);

    const schemaSection = sql.match(/-- --- section:schema ---([\s\S]*?)-- --- end:schema ---/);
    const indexSection = sql.match(/-- --- section:indexes ---([\s\S]*?)-- --- end:indexes ---/);

    expect(schemaSection?.[1]).not.toContain('BEGIN;');
    expect(indexSection?.[1]).not.toContain('COMMIT;');
    expect(sql).toContain('-- --- section:transaction ---');
    expect(sql).toContain('-- --- section:footer ---');
  });

  it('generates Mongo migration', () => {
    const plan = diffEntityConfig(MessageV1, v2);
    const script = generateMigrationMongo(plan);
    expect(script).toContain('createIndex');
    expect(script).toContain('chat_messages');
  });

  it('returns empty for no changes', () => {
    const result = generateMigrations(MessageV1, MessageV1);
    expect(Object.keys(result).length).toBe(0);
  });

  it('generates all backends at once', () => {
    const result = generateMigrations(MessageV1, v2);
    expect(result['migration.sqlite.sql']).toBeDefined();
    expect(result['migration.postgres.sql']).toBeDefined();
    expect(result['migration.mongo.js']).toBeDefined();
  });
});
