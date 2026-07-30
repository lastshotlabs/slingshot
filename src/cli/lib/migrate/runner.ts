/**
 * Migration runner — applies pending migration files to the configured
 * database and tracks which migrations have been applied.
 *
 * Tracking table: `_slingshot_entity_migrations(id TEXT PRIMARY KEY,
 * applied_at TIMESTAMP/INTEGER NOT NULL, checksum TEXT NOT NULL)`. The
 * checksum is the sha256 of the migration SQL, recorded so a subsequent
 * `apply` or `status` run can detect drift (e.g. someone edited an applied
 * migration file).
 *
 * Postgres uses `pg`. SQLite prefers Bun's built-in `bun:sqlite` when the CLI
 * is running under Bun (its shipped shebang is `#!/usr/bin/env bun`, so `bunx
 * slingshot migrate` lands here under Bun, where `better-sqlite3`'s native
 * addon fails to load), and falls back to `better-sqlite3` under Node.
 */
import { runInNewContext } from 'node:vm';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { Backend } from './discover';
import { buildMigrationPlanV2 } from './planV2';
import { migrationsDirFor } from './planner';

/**
 * Dynamic-import a module from the user's project, not from the CLI bundle.
 *
 * The CLI ships from `slingshot`'s `dist/`, where `import('pg')` etc. would
 * try to resolve relative to the bundle's location — failing whenever the
 * user installs the driver in their own project (the normal case). Resolving
 * via `createRequire(process.cwd()/package.json)` walks the user's
 * `node_modules` chain instead, matching how every other Node tool behaves.
 */
async function importFromProject<T>(specifier: string): Promise<T> {
  try {
    const req = createRequire(resolve(process.cwd(), 'package.json'));
    const resolved = req.resolve(specifier);
    return (await import(pathToFileURL(resolved).href)) as T;
  } catch {
    // Fall back to the CLI's own resolution — useful when running from inside
    // the slingshot repo itself, where drivers may be hoisted upstream.
    return (await import(specifier)) as T;
  }
}

export interface AppliedMigration {
  id: string;
  appliedAt: Date;
  checksum: string;
}

export interface PendingMigration {
  id: string;
  filename: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: PendingMigration[];
  /** Applied migrations whose file content has changed since they were applied. */
  drift: { id: string; storedChecksum: string; currentChecksum: string }[];
  /** Applied migration ids that no longer have a corresponding file on disk. */
  missingFiles: string[];
  /**
   * Pending migration ids that sort BEFORE the latest applied id. Applying
   * these would interleave with already-applied state — usually means a
   * migration was added on a branch and merged out of order.
   */
  outOfOrder: string[];
}

const TRACKING_TABLE = '_slingshot_entity_migrations';
const LEDGER_TABLE = '_slingshot_migration_ledger_v2';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function migrationExtension(backend: Backend): '.sql' | '.js' {
  return backend === 'mongo' ? '.js' : '.sql';
}

function parseId(filename: string, ext: string): string | null {
  if (!filename.endsWith(ext)) return null;
  return filename.slice(0, -ext.length);
}

function readPendingFromDisk(migrationsDir: string, backend: Backend): PendingMigration[] {
  const ext = migrationExtension(backend);
  const dir = migrationsDirFor(migrationsDir, backend);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .sort();
  return files
    .map(filename => {
      const id = parseId(filename, ext);
      if (!id) return null;
      const path = join(dir, filename);
      const sql = readFileSync(path, 'utf-8');
      return { id, filename, path, sql, checksum: sha256(sql) };
    })
    .filter((m): m is PendingMigration => m !== null);
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface PgClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release?: () => void;
}

interface PgPool {
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
}

async function loadPgPool(connectionString: string): Promise<PgPool> {
  type PgCtor = new (config: { connectionString: string }) => PgPool;
  type PgShape = { Pool?: PgCtor; default?: { Pool?: PgCtor } };
  let pgModule: PgShape;
  try {
    pgModule = await importFromProject<PgShape>('pg');
  } catch {
    throw new Error(
      "Postgres support requires the 'pg' package. Install it with `bun add pg` " +
        '(or `npm i pg`) in your project.',
    );
  }
  // `pg` is CommonJS; ESM dynamic-import wraps it as `{ default: { Pool, ... } }`.
  // Some loaders also re-expose top-level named keys, so accept either shape.
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  if (!Pool) {
    throw new Error("Loaded 'pg' but could not find the Pool constructor.");
  }
  return new Pool({ connectionString });
}

async function pgEnsureTrackingTable(client: PgClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       checksum TEXT NOT NULL
     )`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       migration_id TEXT PRIMARY KEY,
       plan_checksum TEXT NOT NULL,
       source_schema_checksum TEXT NOT NULL,
       target_schema_checksum TEXT NOT NULL,
       applied_step_ids JSONB NOT NULL,
       started_at TIMESTAMPTZ NOT NULL,
       completed_at TIMESTAMPTZ NOT NULL,
       executor_version TEXT NOT NULL,
       verification_result TEXT NOT NULL
     )`,
  );
}

async function pgListApplied(client: PgClient): Promise<AppliedMigration[]> {
  const { rows } = await client.query(
    `SELECT id, applied_at, checksum FROM ${TRACKING_TABLE} ORDER BY id ASC`,
  );
  return rows.map(r => ({
    id: String(r.id),
    appliedAt: r.applied_at instanceof Date ? r.applied_at : new Date(String(r.applied_at)),
    checksum: String(r.checksum),
  }));
}

async function pgApplyOne(client: PgClient, m: PendingMigration): Promise<void> {
  await client.query(m.sql);
  await client.query(`INSERT INTO ${TRACKING_TABLE} (id, checksum) VALUES ($1, $2)`, [
    m.id,
    m.checksum,
  ]);
}

// ---------------------------------------------------------------------------
// SQLite (better-sqlite3)
// ---------------------------------------------------------------------------

interface SqliteDb {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Record<string, unknown>[];
    run: (...params: unknown[]) => unknown;
  };
  close: () => void;
}

async function loadSqliteDb(path: string): Promise<SqliteDb> {
  type SqliteCtor = new (path: string) => SqliteDb;

  // Under Bun, use the built-in `bun:sqlite` driver. `better-sqlite3` is a
  // native Node addon that does not load under Bun, and the CLI runs under Bun
  // by default (see the `#!/usr/bin/env bun` banner in tsup.cli.config.ts).
  // `bun:sqlite` is externalized in that bundle, so this import survives
  // bundling and resolves at runtime; its `Database` satisfies `SqliteDb`
  // (exec / prepare(...).all|run / close). Node runs fall through to
  // better-sqlite3 below.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    try {
      const bunSqlite = (await import('bun:sqlite')) as unknown as { Database: SqliteCtor };
      return new bunSqlite.Database(path);
    } catch {
      // Fall through to better-sqlite3 — e.g. a Bun build where bun:sqlite is
      // unexpectedly unavailable.
    }
  }

  type SqliteShape = SqliteCtor | { default?: SqliteCtor };
  let mod: SqliteShape;
  try {
    mod = await importFromProject<SqliteShape>('better-sqlite3');
  } catch {
    throw new Error(
      "SQLite support requires the 'better-sqlite3' package. Install it with " +
        '`bun add better-sqlite3` (or `npm i better-sqlite3`).',
    );
  }
  // `better-sqlite3` is CJS with `module.exports = Database`. Dynamic ESM
  // import wraps it as `{ default: Database }`; some loaders also expose the
  // class directly. Accept either.
  const Ctor: SqliteCtor | undefined =
    typeof mod === 'function' ? mod : (mod as { default?: SqliteCtor }).default;
  if (!Ctor) {
    throw new Error("Loaded 'better-sqlite3' but could not find the Database constructor.");
  }
  return new Ctor(path);
}

function sqliteEnsureTrackingTable(db: SqliteDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       id TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
       checksum TEXT NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       migration_id TEXT PRIMARY KEY,
       plan_checksum TEXT NOT NULL,
       source_schema_checksum TEXT NOT NULL,
       target_schema_checksum TEXT NOT NULL,
       applied_step_ids TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       completed_at INTEGER NOT NULL,
       executor_version TEXT NOT NULL,
       verification_result TEXT NOT NULL
     )`,
  );
}

function sqliteListApplied(db: SqliteDb): AppliedMigration[] {
  const rows = db
    .prepare(`SELECT id, applied_at, checksum FROM ${TRACKING_TABLE} ORDER BY id ASC`)
    .all();
  return rows.map(r => ({
    id: String(r.id),
    appliedAt: new Date(Number(r.applied_at)),
    checksum: String(r.checksum),
  }));
}

function sqliteApplyOne(db: SqliteDb, m: PendingMigration): void {
  db.exec(m.sql);
  db.prepare(`INSERT INTO ${TRACKING_TABLE} (id, checksum) VALUES (?, ?)`).run(m.id, m.checksum);
}

interface LedgerRecord {
  migrationId: string;
  planChecksum: string;
  sourceChecksum: string;
  targetChecksum: string;
  stepId: string;
  startedAt: Date;
}

function ledgerRecord(
  migration: PendingMigration,
  plan: ReturnType<typeof buildMigrationPlanV2>,
  startedAt: Date,
): LedgerRecord {
  return {
    migrationId: migration.id,
    planChecksum: sha256(JSON.stringify(plan)),
    sourceChecksum: plan.fromChecksum,
    targetChecksum: plan.toChecksum,
    stepId:
      plan.steps.find(step => step.operation.migrationId === migration.id)?.id ?? migration.id,
    startedAt,
  };
}

async function pgRecordLedger(client: PgClient, record: LedgerRecord): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (migration_id, plan_checksum, source_schema_checksum, target_schema_checksum,
        applied_step_ids, started_at, completed_at, executor_version, verification_result)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), $7, $8)`,
    [
      record.migrationId,
      record.planChecksum,
      record.sourceChecksum,
      record.targetChecksum,
      JSON.stringify([record.stepId]),
      record.startedAt,
      '2',
      'passed',
    ],
  );
}

function sqliteRecordLedger(db: SqliteDb, record: LedgerRecord): void {
  db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (migration_id, plan_checksum, source_schema_checksum, target_schema_checksum,
        applied_step_ids, started_at, completed_at, executor_version, verification_result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.migrationId,
    record.planChecksum,
    record.sourceChecksum,
    record.targetChecksum,
    JSON.stringify([record.stepId]),
    record.startedAt.getTime(),
    Date.now(),
    '2',
    'passed',
  );
}

// ---------------------------------------------------------------------------
// Mongo (mongodb)
// ---------------------------------------------------------------------------

interface MongoCollection {
  findOne: (filter: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  find: (filter?: Record<string, unknown>) => {
    sort: (s: Record<string, number>) => { toArray: () => Promise<Record<string, unknown>[]> };
  };
  insertOne: (doc: Record<string, unknown>) => Promise<unknown>;
  createIndex: (
    spec: Record<string, number>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  dropIndex: (spec: Record<string, number> | string) => Promise<unknown>;
  updateMany: (filter: unknown, update: unknown) => Promise<unknown>;
}

interface MongoDb {
  collection: (name: string) => MongoCollection;
  dropCollection: (name: string) => Promise<unknown>;
  listCollections: () => { toArray: () => Promise<{ name: string }[]> };
}

interface MongoClient {
  connect: () => Promise<MongoClient>;
  db: (name?: string) => MongoDb;
  close: () => Promise<void>;
}

function parseMongoDbName(uri: string): string | undefined {
  // mongodb://host:port/dbname?options or mongodb+srv://host/dbname
  try {
    const stripped = uri.replace(/^mongodb(\+srv)?:\/\//, '');
    const slashIdx = stripped.indexOf('/');
    if (slashIdx === -1) return undefined;
    const after = stripped.slice(slashIdx + 1);
    const qIdx = after.indexOf('?');
    const dbName = qIdx === -1 ? after : after.slice(0, qIdx);
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

async function loadMongoClient(uri: string): Promise<{ client: MongoClient; db: MongoDb }> {
  type MongoCtor = new (uri: string) => MongoClient;
  type MongoShape = { MongoClient?: MongoCtor; default?: { MongoClient?: MongoCtor } };
  let mod: MongoShape;
  try {
    mod = await importFromProject<MongoShape>('mongodb');
  } catch {
    throw new Error(
      "Mongo support requires the 'mongodb' package. Install it with " +
        '`bun add mongodb` (or `npm i mongodb`) in your project.',
    );
  }
  const Ctor = mod.MongoClient ?? mod.default?.MongoClient;
  if (!Ctor) {
    throw new Error("Loaded 'mongodb' but could not find the MongoClient constructor.");
  }
  const client = new Ctor(uri);
  await client.connect();
  const dbName = parseMongoDbName(uri);
  const db = client.db(dbName);
  return { client, db };
}

async function mongoEnsureTracking(db: MongoDb): Promise<void> {
  await db.collection(TRACKING_TABLE).createIndex({ id: 1 }, { unique: true });
}

async function mongoListApplied(db: MongoDb): Promise<AppliedMigration[]> {
  const rows = await db.collection(TRACKING_TABLE).find({}).sort({ id: 1 }).toArray();
  return rows.map(r => ({
    id: String(r.id),
    appliedAt: r.appliedAt instanceof Date ? r.appliedAt : new Date(String(r.appliedAt)),
    checksum: String(r.checksum),
  }));
}

/**
 * Wrap a generated mongo migration script so that every `db.getCollection(...)`
 * (and `db.collection(...)`) call is awaited, then run inside an async IIFE.
 *
 * The generator emits mongosh-style `db.getCollection("x").createIndex(...);`
 * — calls that return Promises in the Node driver. Without `await` they
 * fire-and-forget and lose error propagation. The regex below adds `await`
 * before any leading `db.` call that isn't already awaited; the IIFE wrapper
 * then awaits the whole thing.
 */
function wrapMongoScript(script: string): string {
  const transformed = script.replace(
    /^(\s*)(?!await\s)(db\.(getCollection|collection)\b)/gm,
    '$1await $2',
  );
  return `(async () => {\n${transformed}\n})()`;
}

async function mongoApplyOne(db: MongoDb, m: PendingMigration): Promise<void> {
  const wrapped = wrapMongoScript(m.sql);
  const dbProxy = new Proxy(db as unknown as object, {
    get(target, prop, receiver) {
      if (prop === 'getCollection') {
        return (name: string) => (target as MongoDb).collection(name);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  await runInNewContext(wrapped, { db: dbProxy, console }, { timeout: 60_000 });
  await db
    .collection(TRACKING_TABLE)
    .insertOne({ id: m.id, appliedAt: new Date(), checksum: m.checksum });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getStatus(args: {
  backend: Backend;
  connectionString: string;
  migrationsDir: string;
}): Promise<MigrationStatus> {
  const onDisk = readPendingFromDisk(args.migrationsDir, args.backend);
  const onDiskById = new Map(onDisk.map(m => [m.id, m]));

  let applied: AppliedMigration[];

  if (args.backend === 'postgres') {
    const pool = await loadPgPool(args.connectionString);
    const client = await pool.connect();
    try {
      await pgEnsureTrackingTable(client);
      applied = await pgListApplied(client);
    } finally {
      client.release?.();
      await pool.end();
    }
  } else if (args.backend === 'mongo') {
    const { client, db } = await loadMongoClient(args.connectionString);
    try {
      await mongoEnsureTracking(db);
      applied = await mongoListApplied(db);
    } finally {
      await client.close();
    }
  } else {
    const db = await loadSqliteDb(args.connectionString);
    try {
      sqliteEnsureTrackingTable(db);
      applied = sqliteListApplied(db);
    } finally {
      db.close();
    }
  }

  const appliedIds = new Set(applied.map(a => a.id));
  const drift: MigrationStatus['drift'] = [];
  const missingFiles: string[] = [];
  for (const a of applied) {
    const onDiskMatch = onDiskById.get(a.id);
    if (!onDiskMatch) {
      missingFiles.push(a.id);
      continue;
    }
    if (onDiskMatch.checksum !== a.checksum) {
      drift.push({ id: a.id, storedChecksum: a.checksum, currentChecksum: onDiskMatch.checksum });
    }
  }

  const pending = onDisk.filter(m => !appliedIds.has(m.id));

  const latestApplied = applied.length > 0 ? applied[applied.length - 1].id : '';
  const outOfOrder = pending.filter(p => p.id < latestApplied).map(p => p.id);

  return { applied, pending, drift, missingFiles, outOfOrder };
}

export async function dropAll(args: {
  backend: Backend;
  connectionString: string;
  /** Backend-specific table names to drop. */
  tableNames: string[];
}): Promise<{ dropped: string[] }> {
  const dropped: string[] = [];

  if (args.backend === 'postgres') {
    const pool = await loadPgPool(args.connectionString);
    const client = await pool.connect();
    try {
      for (const name of args.tableNames) {
        await client.query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
        dropped.push(name);
      }
      await client.query(`DROP TABLE IF EXISTS ${TRACKING_TABLE} CASCADE`);
      dropped.push(TRACKING_TABLE);
    } finally {
      client.release?.();
      await pool.end();
    }
  } else if (args.backend === 'mongo') {
    const { client, db } = await loadMongoClient(args.connectionString);
    try {
      const existing = new Set((await db.listCollections().toArray()).map(c => c.name));
      for (const name of args.tableNames) {
        if (existing.has(name)) {
          await db.dropCollection(name);
          dropped.push(name);
        }
      }
      if (existing.has(TRACKING_TABLE)) {
        await db.dropCollection(TRACKING_TABLE);
        dropped.push(TRACKING_TABLE);
      }
    } finally {
      await client.close();
    }
  } else {
    const db = await loadSqliteDb(args.connectionString);
    try {
      for (const name of args.tableNames) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
        dropped.push(name);
      }
      db.exec(`DROP TABLE IF EXISTS ${TRACKING_TABLE}`);
      dropped.push(TRACKING_TABLE);
    } finally {
      db.close();
    }
  }

  return { dropped };
}

export async function applyPending(args: {
  backend: Backend;
  connectionString: string;
  migrationsDir: string;
  approve?: string;
}): Promise<{ applied: PendingMigration[]; drift: MigrationStatus['drift'] }> {
  const status = await getStatus(args);
  if (status.drift.length > 0) {
    throw new Error(
      `Drift detected. The following applied migrations have different content on disk than ` +
        `when they were applied:\n` +
        status.drift.map(d => `  - ${d.id}`).join('\n') +
        `\nFix the file or restore from history. Refusing to apply new migrations until drift is resolved.`,
    );
  }
  if (status.outOfOrder.length > 0) {
    throw new Error(
      `Out-of-order migrations detected. The following pending migrations sort before ` +
        `already-applied migrations:\n` +
        status.outOfOrder.map(id => `  - ${id}`).join('\n') +
        `\nThis usually happens when a branch with older-timestamped migrations is merged. ` +
        `Rename the files with newer timestamps, or run \`slingshot migrate reset --force\` ` +
        `in dev to rebuild from scratch.`,
    );
  }
  if (status.missingFiles.length > 0) {
    throw new Error(
      `Applied migrations have no corresponding file on disk:\n` +
        status.missingFiles.map(id => `  - ${id}`).join('\n') +
        `\nRestore the missing files (typically from git) before applying new migrations.`,
    );
  }
  if (status.pending.length === 0) return { applied: [], drift: [] };
  const plan = buildMigrationPlanV2(args.backend, status);
  if (plan.approvalDigest && args.approve !== plan.approvalDigest) {
    throw new Error(
      `This migration plan contains contract or destructive work. ` +
        `Review \`slingshot migrate plan\` and rerun with --approve ${plan.approvalDigest}`,
    );
  }

  const applied: PendingMigration[] = [];

  if (args.backend === 'postgres') {
    const pool = await loadPgPool(args.connectionString);
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [
        `slingshot:migrate:${args.connectionString}`,
      ]);
      await pgEnsureTrackingTable(client);
      const alreadyApplied = new Set((await pgListApplied(client)).map(migration => migration.id));
      for (const m of status.pending.filter(migration => !alreadyApplied.has(migration.id))) {
        const startedAt = new Date();
        await client.query('BEGIN');
        try {
          await pgApplyOne(client, m);
          await pgRecordLedger(client, ledgerRecord(m, plan, startedAt));
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        applied.push(m);
      }
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          `slingshot:migrate:${args.connectionString}`,
        ])
        .catch(() => undefined);
      client.release?.();
      await pool.end();
    }
  } else if (args.backend === 'mongo') {
    const { client, db } = await loadMongoClient(args.connectionString);
    try {
      await mongoEnsureTracking(db);
      for (const m of status.pending) {
        await mongoApplyOne(db, m);
        applied.push(m);
      }
    } finally {
      await client.close();
    }
  } else {
    const db = await loadSqliteDb(args.connectionString);
    try {
      sqliteEnsureTrackingTable(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        const alreadyApplied = new Set(sqliteListApplied(db).map(migration => migration.id));
        for (const m of status.pending.filter(migration => !alreadyApplied.has(migration.id))) {
          const startedAt = new Date();
          sqliteApplyOne(db, m);
          sqliteRecordLedger(db, ledgerRecord(m, plan, startedAt));
          applied.push(m);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
  }

  return { applied, drift: [] };
}
