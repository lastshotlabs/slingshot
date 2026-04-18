// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-postgres/testing — Test utilities
//
// Provides helpers for resetting Postgres state between tests.
// Requires a real Postgres connection — use only in docker-based integration
// or e2e tests, NOT in unit tests.
// ---------------------------------------------------------------------------
import type { DrizzlePostgresDb } from './connection';
import * as schema from './schema';

/**
 * Truncates all slingshot auth tables in child→parent order to respect FK constraints.
 * Use this in `afterEach` / `afterAll` to reset Postgres state between test runs.
 *
 * Deletes rows from: `groupMemberships`, `recoveryCodes`, `webauthnCredentials`,
 * `oauthAccounts`, `userRoles`, `tenantRoles`, then `groups` and `users`.
 *
 * @param db - A live `DrizzlePostgresDb` handle (from `connectPostgres`).
 * @returns A promise that resolves when all tables have been truncated.
 *
 * @remarks
 * Requires a real Postgres connection — use only in Docker-based integration or e2e tests,
 * NOT in unit tests.
 *
 * @example
 * ```ts
 * import { clearPostgresAuthTables } from '@lastshotlabs/slingshot-postgres/testing';
 *
 * afterEach(async () => {
 *   await clearPostgresAuthTables(db);
 * });
 * ```
 */
export async function clearPostgresAuthTables(db: DrizzlePostgresDb): Promise<void> {
  const { db: drizzleDb } = db;
  // Child tables first (FK references users/groups)
  await drizzleDb.delete(schema.groupMemberships);
  await drizzleDb.delete(schema.recoveryCodes);
  await drizzleDb.delete(schema.webauthnCredentials);
  await drizzleDb.delete(schema.oauthAccounts);
  await drizzleDb.delete(schema.userRoles);
  await drizzleDb.delete(schema.tenantRoles);
  // Parent tables last
  await drizzleDb.delete(schema.groups);
  await drizzleDb.delete(schema.users);
}

export type { DrizzlePostgresDb } from './connection';
export { connectPostgres } from './connection';
