/**
 * Per-backend migration generator unit tests.
 *
 * Covers the diff → MigrationPlan → SQL/Mongo script path for sqlite, postgres, and mongo
 * independently of the CLI wrapper.
 */
import { describe, expect, it } from 'bun:test';
import { defineEntity, field, index } from '../../src/index';
import { diffEntityConfig } from '../../src/migrations/diff';
import { generateMigrationMongo } from '../../src/migrations/generators/mongo';
import { generateMigrationPostgres } from '../../src/migrations/generators/postgres';
import { generateMigrationSqlite } from '../../src/migrations/generators/sqlite';
import { generateMigrations } from '../../src/migrations/index';

const WidgetV1 = defineEntity('Widget', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    sku: field.string(),
    price: field.number({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['sku'])],
});

const WidgetV2 = defineEntity('Widget', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    sku: field.string(),
    // price removed
    description: field.string({ optional: true }),
    tagLine: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['sku']), index(['tagLine'])],
  uniques: [{ fields: ['sku'] }],
});

describe('diffEntityConfig', () => {
  it('detects added fields, removed fields, added indexes, and added unique constraints', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);

    const kinds = plan.changes.map(c => c.type).sort();
    expect(kinds).toContain('addField');
    expect(kinds).toContain('removeField');
    expect(kinds).toContain('addIndex');
    expect(kinds).toContain('addUnique');

    const added = plan.changes
      .filter(c => c.type === 'addField')
      .map(c => ('name' in c ? c.name : ''));
    expect(added).toContain('description');
    expect(added).toContain('tagLine');

    const removed = plan.changes
      .filter(c => c.type === 'removeField')
      .map(c => ('name' in c ? c.name : ''));
    expect(removed).toContain('price');
  });

  it('returns an empty plan when configs are identical', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV1);
    expect(plan.changes).toHaveLength(0);
    expect(plan.hasBreakingChanges).toBe(false);
  });

  it('populates per-backend storage names on the plan', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    expect(plan.storageNames.sqlite).toBe(WidgetV2._storageName);
    expect(plan.storageNames.mongo).toBe(WidgetV2._storageName);
    expect(plan.storageNames.postgres).toBe(`slingshot_${WidgetV2._storageName}`);
  });

  it('emits removals before additions for indexes (enables toggling unique)', () => {
    const Base = defineEntity('Doc', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        slug: field.string(),
      },
      indexes: [index(['slug'])], // non-unique
    });
    const UniqueSlug = defineEntity('Doc', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        slug: field.string(),
      },
      indexes: [index(['slug'], { unique: true })], // unique toggled
    });
    const plan = diffEntityConfig(Base, UniqueSlug);
    const indexChanges = plan.changes.filter(
      c => c.type === 'addIndex' || c.type === 'removeIndex',
    );
    expect(indexChanges).toHaveLength(2);
    expect(indexChanges[0].type).toBe('removeIndex');
    expect(indexChanges[1].type).toBe('addIndex');
  });

  it('detects field type changes as breaking', () => {
    const Before = defineEntity('Row', {
      fields: {
        id: field.string({ primary: true }),
        count: field.string(),
      },
    });
    const After = defineEntity('Row', {
      fields: {
        id: field.string({ primary: true }),
        count: field.integer(),
      },
    });
    const plan = diffEntityConfig(Before, After);
    expect(plan.hasBreakingChanges).toBe(true);
    expect(plan.changes.map(c => c.type)).toContain('changeFieldType');
  });

  it('throws when the primary key field changes', () => {
    const A = defineEntity('A', {
      fields: { id: field.string({ primary: true }), name: field.string() },
    });
    const B = defineEntity('A', {
      fields: {
        id: field.string(),
        uid: field.string({ primary: true }),
        name: field.string(),
      },
    });
    expect(() => diffEntityConfig(A, B)).toThrow(/Primary key changed/);
  });

  it('detects removed indexes and removed unique constraints', () => {
    const Full = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
      indexes: [index(['tenantId'])],
      uniques: [{ fields: ['email'] }],
    });
    const Stripped = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
    });
    const plan = diffEntityConfig(Full, Stripped);
    const kinds = plan.changes.map(c => c.type);
    expect(kinds).toContain('removeIndex');
    expect(kinds).toContain('removeUnique');
  });
});

describe('generateMigrationSqlite', () => {
  it('produces ALTER TABLE ADD COLUMN with quoted identifiers for added fields', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationSqlite(plan);

    expect(sql).toContain('ALTER TABLE');
    expect(sql).toContain('ADD COLUMN "description" TEXT');
    expect(sql).toContain('ADD COLUMN "tag_line" TEXT');
  });

  it('emits CREATE INDEX with quoted identifiers for added indexes', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "idx_[^"]+" ON "[^"]+" \("tag_line"\)/);
  });

  it('emits a unique index with quoted identifiers for added unique constraints', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "uidx_[^"]+_sku"/);
  });

  it('commented DROP COLUMN for removed fields (SQLite pre-3.35 safety)', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toContain('-- ALTER TABLE');
    expect(sql).toContain('DROP COLUMN "price"');
  });

  it('returns empty string for an empty plan', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV1);
    expect(generateMigrationSqlite(plan)).toBe('');
  });

  it('output is deterministic — no timestamps or run-specific state', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const a = generateMigrationSqlite(plan);
    const b = generateMigrationSqlite(plan);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
  });

  it('emits section markers that enclose every logical block (rule 13)', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toContain('-- --- section:header ---');
    expect(sql).toContain('-- --- end:header ---');
    expect(sql).toContain('-- --- section:schema ---');
    expect(sql).toContain('-- --- end:schema ---');
    expect(sql).toContain('-- --- section:indexes ---');
    expect(sql).toContain('-- --- end:indexes ---');
    expect(sql).toContain('-- --- section:warnings ---');
    expect(sql).toContain('-- --- end:warnings ---');
  });

  it('escapes single quotes in string defaults', () => {
    const Before = defineEntity('Quote', {
      fields: { id: field.string({ primary: true }) },
    });
    const After = defineEntity('Quote', {
      fields: {
        id: field.string({ primary: true }),
        label: field.string({ default: "O'Brien" }),
      },
    });
    const plan = diffEntityConfig(Before, After);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toContain("DEFAULT 'O''Brien'");
  });

  it('emits DROP INDEX for removed indexes and unique constraints', () => {
    const Full = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
      indexes: [index(['tenantId'])],
      uniques: [{ fields: ['email'] }],
    });
    const Stripped = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
    });
    const plan = diffEntityConfig(Full, Stripped);
    const sql = generateMigrationSqlite(plan);
    expect(sql).toMatch(/DROP INDEX IF EXISTS "idx_[^"]+_tenant_id"/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS "uidx_[^"]+_email"/);
  });

  it('does not backfill DEFAULT empty-string for required numeric fields without defaults', () => {
    const Before = defineEntity('Counter', {
      fields: { id: field.string({ primary: true }) },
    });
    const After = defineEntity('Counter', {
      fields: {
        id: field.string({ primary: true }),
        count: field.integer(),
      },
    });
    const plan = diffEntityConfig(Before, After);
    const sql = generateMigrationSqlite(plan);

    expect(sql).toContain('ADD COLUMN "count" INTEGER;');
    expect(sql).not.toContain(`DEFAULT ''`);
    expect(sql).toContain('Backfill "count"');
  });
});

describe('generateMigrationPostgres', () => {
  it('targets the slingshot_-prefixed table name', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain(`"slingshot_${WidgetV2._storageName}"`);
  });

  it('wraps schema statements in BEGIN / COMMIT', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('emits ALTER TABLE ADD COLUMN with Postgres types and quoted identifiers', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain('ADD COLUMN "description" TEXT');
    expect(sql).toContain('ADD COLUMN "tag_line" TEXT');
  });

  it('supports DROP COLUMN for removed fields', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    expect(sql).toContain('DROP COLUMN IF EXISTS "price"');
  });

  it('returns empty string for an empty plan', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV1);
    expect(generateMigrationPostgres(plan)).toBe('');
  });

  it('output is deterministic', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    expect(generateMigrationPostgres(plan)).toBe(generateMigrationPostgres(plan));
    expect(generateMigrationPostgres(plan)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('emits section markers around schema, indexes, warnings, and header', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    for (const name of ['header', 'warnings', 'schema', 'indexes']) {
      expect(sql).toContain(`-- --- section:${name} ---`);
      expect(sql).toContain(`-- --- end:${name} ---`);
    }
  });

  it('keeps index statements inside the transaction', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const sql = generateMigrationPostgres(plan);
    const commitAt = sql.indexOf('COMMIT;');
    const createIndexAt = sql.indexOf('CREATE INDEX IF NOT EXISTS');
    const createUniqueAt = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS');

    expect(createIndexAt).toBeGreaterThan(-1);
    expect(createUniqueAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(createIndexAt);
    expect(commitAt).toBeGreaterThan(createUniqueAt);
  });
});

describe('generateMigrationMongo', () => {
  it('targets the collection via db.getCollection() (safe for hyphens / reserved names)', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    expect(script).toContain(`db.getCollection("${plan.storageNames.mongo}")`);
    // Ensure no bare `db.<storageName>.` form is ever emitted — collection
    // access must go through `getCollection` so hyphens / reserved words work.
    expect(script).not.toContain(`db.${plan.storageNames.mongo}.`);
  });

  it('uses bracket notation for field keys in $set / $unset operations', () => {
    const Before = defineEntity('Thing', {
      fields: { id: field.string({ primary: true }), oldKey: field.string() },
    });
    const After = defineEntity('Thing', {
      fields: { id: field.string({ primary: true }) },
    });
    const plan = diffEntityConfig(Before, After);
    const script = generateMigrationMongo(plan);
    expect(script).toContain('{ $unset: { ["oldKey"]: "" } }');
  });

  it('documents schemaless add and emits createIndex for added indexes', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    expect(script).toContain('"description"');
    expect(script).toContain('createIndex');
    expect(script).toContain('"tagLine"');
  });

  it('emits $unset updateMany for removed fields', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    expect(script).toContain('$unset');
    expect(script).toContain('"price"');
  });

  it('emits createIndex with unique:true for added unique constraints', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    expect(script).toContain('unique: true');
  });

  it('emits dropIndex for removed indexes and unique constraints', () => {
    const Full = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
      indexes: [index(['tenantId'])],
      uniques: [{ fields: ['email'] }],
    });
    const Stripped = defineEntity('U', {
      fields: {
        id: field.string({ primary: true }),
        email: field.string(),
        tenantId: field.string(),
      },
    });
    const plan = diffEntityConfig(Full, Stripped);
    const script = generateMigrationMongo(plan);
    expect(script).toMatch(/\.dropIndex\(\{ "tenantId": 1 \}\)/);
    expect(script).toMatch(/\.dropIndex\(\{ "email": 1 \}\)/);
  });

  it('returns empty string for an empty plan', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV1);
    expect(generateMigrationMongo(plan)).toBe('');
  });

  it('output is deterministic and parses as valid JavaScript', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    expect(generateMigrationMongo(plan)).toBe(script);
    // Should parse without syntax errors (ignoring the undefined `db`
    // identifier — we only care the script is syntactically valid JS).
     
    expect(() => new Function('db', script)).not.toThrow();
  });

  it('emits section markers for every logical block', () => {
    const plan = diffEntityConfig(WidgetV1, WidgetV2);
    const script = generateMigrationMongo(plan);
    for (const name of ['header', 'warnings', 'schema', 'indexes']) {
      expect(script).toContain(`// --- section:${name} ---`);
      expect(script).toContain(`// --- end:${name} ---`);
    }
  });
});

describe('generateMigrations (backend dispatch)', () => {
  it('returns scripts for the default backend set (sqlite, postgres, mongo)', () => {
    const result = generateMigrations(WidgetV1, WidgetV2);
    expect(Object.keys(result).sort()).toEqual([
      'migration.mongo.js',
      'migration.postgres.sql',
      'migration.sqlite.sql',
    ]);
  });

  it('honors an explicit backend filter', () => {
    const result = generateMigrations(WidgetV1, WidgetV2, ['sqlite']);
    expect(Object.keys(result)).toEqual(['migration.sqlite.sql']);
  });

  it('returns an empty map when there are no changes', () => {
    const result = generateMigrations(WidgetV1, WidgetV1);
    expect(result).toEqual({});
  });
});
