/**
 * End-to-end integration tests: generate() with snapshot lifecycle and --migration flag.
 *
 * Flow:
 *   1. First generate run — no snapshot → generates source files, saves snapshot, no migration output.
 *   2. Entity changes (field added).
 *   3. Second generate run with migration: true → migration scripts appear in file map.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { writeGenerated } from '../../src/cli';
import { defineEntity, field, index } from '../../src/index';
import { loadSnapshot } from '../../src/migrations/snapshotStore';

const TMP_DIR = join(import.meta.dir, '../.tmp-migration-integration-test');
const SNAPSHOT_DIR = join(TMP_DIR, 'snapshots');
const OUT_DIR = join(TMP_DIR, 'generated');

const OrderV1 = defineEntity('Order', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    customerId: field.string(),
    status: field.enum(['pending', 'shipped', 'delivered'], { default: 'pending' }),
    total: field.number({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['customerId'])],
});

const OrderV2 = defineEntity('Order', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    customerId: field.string(),
    status: field.enum(['pending', 'shipped', 'delivered'], { default: 'pending' }),
    total: field.number({ default: 0 }),
    // Added field
    trackingCode: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['customerId']), index(['status'])],
});

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('first run (no snapshot)', () => {
  it('generates source files', () => {
    const files = writeGenerated(OrderV1, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      dryRun: true,
    });
    expect(files['types.ts']).toBeDefined();
    expect(files['schemas.ts']).toBeDefined();
    expect(files['adapter.ts']).toBeDefined();
    expect(files['sqlite.ts']).toBeDefined();
    expect(files['postgres.ts']).toBeDefined();
    expect(files['index.ts']).toBeDefined();
  });

  it('produces no migration files on first run', () => {
    const files = writeGenerated(OrderV1, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });
    const migrationFiles = Object.keys(files).filter(f => f.startsWith('migrations/'));
    expect(migrationFiles.length).toBe(0);
  });

  it('saves snapshot after first run', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });
    const snapshot = loadSnapshot(SNAPSHOT_DIR, OrderV1);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entity.name).toBe('Order');
    expect(snapshot!.entity._storageName).toBe(OrderV1._storageName);
  });
});

describe('second run with changed entity and --migration', () => {
  it('produces migration files when entity config changed', () => {
    // First run — saves snapshot
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    // Second run — with changed entity and migration flag
    const files = writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });

    const migrationFiles = Object.keys(files).filter(f => f.startsWith('migrations/'));
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('includes SQLite migration script with ALTER TABLE for added field', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    const files = writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });

    const sqliteKey = Object.keys(files).find(
      f => f.startsWith('migrations/') && f.endsWith('sqlite.sql'),
    );
    expect(sqliteKey).toBeDefined();
    const sql = files[sqliteKey!];
    expect(sql).toContain('ALTER TABLE');
    expect(sql).toContain('tracking_code');
  });

  it('includes Postgres migration with BEGIN/COMMIT block', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    const files = writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });

    const pgKey = Object.keys(files).find(
      f => f.startsWith('migrations/') && f.endsWith('postgres.sql'),
    );
    expect(pgKey).toBeDefined();
    const sql = files[pgKey!];
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('COMMIT');
  });

  it('includes Mongo migration script', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    const files = writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });

    const mongoKey = Object.keys(files).find(
      f => f.startsWith('migrations/') && f.endsWith('mongo.js'),
    );
    expect(mongoKey).toBeDefined();
  });

  it('updates snapshot to current entity after migration run', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });
    writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
    });

    const snapshot = loadSnapshot(SNAPSHOT_DIR, OrderV2);
    expect(snapshot).not.toBeNull();
    // Snapshot should now reflect V2 — trackingCode should be present
    expect(Object.keys(snapshot!.entity.fields)).toContain('trackingCode');
  });
});

describe('second run with no changes', () => {
  it('generates no migration files when entity is unchanged', () => {
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    const files = writeGenerated(OrderV1, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      migration: true,
      dryRun: true,
    });

    const migrationFiles = Object.keys(files).filter(f => f.startsWith('migrations/'));
    expect(migrationFiles.length).toBe(0);
  });
});

describe('snapshotDir without migration flag', () => {
  it('preserves the last migrated snapshot and produces no migration files', () => {
    // Run once to create snapshot
    writeGenerated(OrderV1, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });

    // Run again with changed entity but WITHOUT migration flag
    const files = writeGenerated(OrderV2, {
      outDir: OUT_DIR,
      snapshotDir: SNAPSHOT_DIR,
      // migration is not set
      dryRun: true,
    });

    const migrationFiles = Object.keys(files).filter(f => f.startsWith('migrations/'));
    expect(migrationFiles.length).toBe(0);

    // Snapshot should remain on the last migrated shape until a migration run advances it.
    writeGenerated(OrderV2, { outDir: OUT_DIR, snapshotDir: SNAPSHOT_DIR });
    const snapshot = loadSnapshot(SNAPSHOT_DIR, OrderV2);
    expect(Object.keys(snapshot!.entity.fields)).not.toContain('trackingCode');
  });
});
