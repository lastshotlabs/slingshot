import { describe, expect, it } from 'bun:test';
import { defineEntity, field, index } from '../../packages/slingshot-entity/src';
import {
  diffEntityConfig,
  generateMigrationMongo,
  generateMigrationPostgres,
  generateMigrationSqlite,
  generateMigrations,
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
