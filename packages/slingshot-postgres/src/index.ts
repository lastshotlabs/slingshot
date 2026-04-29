/**
 * Create the Slingshot entity adapter backed by Postgres.
 */
export { createPostgresAdapter } from './adapter.js';
/**
 * Options accepted by the Postgres entity adapter.
 */
export type { PostgresAdapterOptions } from './adapter.js';
/**
 * Drizzle database and connection configuration types for Postgres runtime wiring.
 */
export type {
  DrizzlePostgresDb,
  PostgresConnectionOptions,
  PostgresPoolConfig,
} from './connection.js';
/**
 * Create a Postgres connection and Drizzle database handle.
 */
export { connectPostgres } from './connection.js';

/**
 * Parse and validate a stored migration version against the binary's max version.
 * Useful for tests and custom migration tooling.
 */
export { parseMigrationVersion } from './adapter.js';
