/**
 * Migration planner — collects per-entity diffs across the whole manifest,
 * combines them into a single timestamped migration file per backend, and
 * advances entity snapshots atomically after the file is written.
 *
 * Producing one migration file per "name" (rather than per-entity) matches
 * Prisma's UX: the user runs `slingshot migrate generate --name add_nickname`
 * once and gets a single file capturing every entity change in that step.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  diffEntityConfig,
  generateInitialMigrationMongo,
  generateInitialMigrationPostgres,
  generateInitialMigrationSqlite,
  generateMigrationMongo,
  generateMigrationPostgres,
  generateMigrationSqlite,
  loadSnapshot,
  saveSnapshot,
} from '@lastshotlabs/slingshot-entity';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';
import type { Backend } from './discover';

export interface PlannedMigration {
  /** Timestamped id (e.g. `20260501123045_init`). */
  id: string;
  /** Filename (e.g. `20260501123045_init.sql`). */
  filename: string;
  /** Absolute path the file would be written to. */
  path: string;
  /** Combined SQL content. Empty when no changes were detected. */
  sql: string;
  /** Sha256 of the SQL content — used for drift detection during apply. */
  checksum: string;
  /** Per-entity SQL fragments (in the same order they appear in `sql`). */
  perEntity: Record<string, string>;
  /** Entities that produced changes — drives snapshot advancement. */
  changedEntities: ResolvedEntityConfig[];
}

function timestampId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'migration';
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

export function migrationsDirFor(rootDir: string, backend: Backend): string {
  return join(rootDir, backend);
}

/**
 * Build a migration plan without writing anything to disk. The caller decides
 * whether to write the file and advance snapshots.
 */
export function planMigration(args: {
  entities: Record<string, ResolvedEntityConfig>;
  snapshotDir: string;
  migrationsDir: string;
  backend: Backend;
  name: string;
  timestamp?: string;
}): PlannedMigration {
  const { entities, snapshotDir, migrationsDir, backend } = args;
  const id = `${args.timestamp ?? timestampId()}_${sanitizeName(args.name)}`;
  const filename = `${id}.${backend === 'mongo' ? 'js' : 'sql'}`;

  const sections: string[] = [];
  const perEntity: Record<string, string> = {};
  const changedEntities: ResolvedEntityConfig[] = [];

  // Stable iteration order — entities by name.
  const sortedEntries = Object.entries(entities).sort(([a], [b]) => a.localeCompare(b));

  const commentPrefix = backend === 'mongo' ? '//' : '--';

  for (const [entityName, config] of sortedEntries) {
    const snapshot = loadSnapshot(snapshotDir, config);

    let sql: string;
    if (!snapshot) {
      // First migration for this entity.
      sql =
        backend === 'postgres'
          ? generateInitialMigrationPostgres(config)
          : backend === 'sqlite'
            ? generateInitialMigrationSqlite(config)
            : generateInitialMigrationMongo(config);
    } else {
      const plan = diffEntityConfig(snapshot.entity, config);
      if (plan.changes.length === 0) continue;
      sql =
        backend === 'postgres'
          ? generateMigrationPostgres(plan)
          : backend === 'sqlite'
            ? generateMigrationSqlite(plan)
            : generateMigrationMongo(plan);
    }

    if (!sql || !sql.trim()) continue;

    perEntity[entityName] = sql;
    changedEntities.push(config);
    sections.push(`${commentPrefix} ===== entity: ${entityName} =====\n${sql}`);
  }

  const sql = sections.join('\n\n');
  return {
    id,
    filename,
    path: join(migrationsDirFor(migrationsDir, backend), filename),
    sql,
    checksum: sha256(sql),
    perEntity,
    changedEntities,
  };
}

/**
 * Write a planned migration to disk and advance snapshots for every entity
 * whose schema contributed to it. Snapshots are advanced ONLY after the file
 * write succeeds — if the write throws, the snapshot dir stays consistent with
 * the previous migration, so the next run will regenerate the same plan.
 */
export function writeMigration(args: {
  plan: PlannedMigration;
  snapshotDir: string;
}): void {
  const { plan, snapshotDir } = args;
  if (!plan.sql.trim()) return;

  const dir = plan.path.split('/').slice(0, -1).join('/');
  mkdirSync(dir, { recursive: true });

  if (existsSync(plan.path)) {
    throw new Error(
      `Migration file already exists at ${plan.path}. Choose a different --name ` +
        `or wait at least one second to get a new timestamp.`,
    );
  }

  writeFileSync(plan.path, plan.sql, 'utf-8');

  for (const config of plan.changedEntities) {
    saveSnapshot(snapshotDir, config);
  }
}
