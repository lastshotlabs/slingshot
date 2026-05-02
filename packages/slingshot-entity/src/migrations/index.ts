/**
 * Schema migrations — diff entity definitions and generate per-backend migration scripts.
 */
import type { Backend } from '../generators/filter';
import type { ResolvedEntityConfig } from '../types';
import { diffEntityConfig } from './diff';
import { generateMigrationMongo } from './generators/mongo';
import { generateMigrationPostgres } from './generators/postgres';
import { generateMigrationSqlite } from './generators/sqlite';

export type { MigrationPlan, MigrationChange, EntitySnapshot } from './types';
export { diffEntityConfig } from './diff';
export { loadSnapshot, saveSnapshot } from './snapshotStore';
export { generateMigrationSqlite } from './generators/sqlite';
export { generateMigrationPostgres } from './generators/postgres';
export { generateMigrationMongo } from './generators/mongo';
export {
  generateInitialMigrationPostgres,
  generateInitialMigrationSqlite,
} from './generators/initial';
export { generateInitialMigrationMongo } from './generators/initialMongo';

/**
 * Generate migration scripts for all specified backends by diffing two entity
 * configs.
 *
 * Calls `diffEntityConfig()` internally and routes the `MigrationPlan` to
 * each backend-specific generator. Returns an empty object when no changes are
 * detected. The returned map keys use the pattern `migration.<backend>.<ext>`
 * (e.g. `migration.sqlite.sql`, `migration.postgres.sql`,
 * `migration.mongo.js`).
 *
 * @param previous - The older entity config (typically from a snapshot).
 * @param current - The newer entity config (the current definition).
 * @param backends - Which backends to generate scripts for. Defaults to
 *   `['sqlite', 'postgres', 'mongo']`. `'memory'` and `'redis'` are silently
 *   ignored since they are schemaless.
 * @returns A map of filename → migration script content. Entries with empty
 *   content are omitted.
 *
 * @throws {Error} When the primary key changed between configs (PK changes
 *   cannot be automated).
 *
 * @example
 * ```ts
 * import { generateMigrations, loadSnapshot } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 *
 * const snapshot = loadSnapshot('.slingshot/snapshots', Message);
 * if (snapshot) {
 *   const scripts = generateMigrations(snapshot.entity, Message, ['sqlite', 'postgres']);
 *   for (const [file, sql] of Object.entries(scripts)) {
 *     console.log(`--- ${file} ---\n${sql}`);
 *   }
 * }
 * ```
 */
export function generateMigrations(
  previous: ResolvedEntityConfig,
  current: ResolvedEntityConfig,
  backends?: Backend[],
): Record<string, string> {
  const plan = diffEntityConfig(previous, current);
  if (plan.changes.length === 0) return {};

  const result: Record<string, string> = {};
  const targetBackends = backends ?? ['sqlite', 'postgres', 'mongo'];

  if (targetBackends.includes('sqlite')) {
    const sql = generateMigrationSqlite(plan);
    if (sql) result['migration.sqlite.sql'] = sql;
  }

  if (targetBackends.includes('postgres')) {
    const sql = generateMigrationPostgres(plan);
    if (sql) result['migration.postgres.sql'] = sql;
  }

  if (targetBackends.includes('mongo')) {
    const script = generateMigrationMongo(plan);
    if (script) result['migration.mongo.js'] = script;
  }

  return result;
}
