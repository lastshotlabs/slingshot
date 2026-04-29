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
