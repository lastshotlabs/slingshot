/**
 * E2E Multi-Backend Factory
 *
 * Resolves storage backend configuration from environment variables.
 * Defaults to memory for all stores when no env vars are set.
 *
 * Environment variables (all optional, all default to 'memory'):
 *
 *   TEST_BACKEND          — shorthand: sets all backends at once
 *   SLINGSHOT_E2E_AUTH_BACKEND      — auth adapter backend
 *   SLINGSHOT_E2E_SESSION_BACKEND   — session store backend
 *   SLINGSHOT_E2E_CACHE_BACKEND     — cache store backend
 *
 * Per-backend env vars override TEST_BACKEND when both are set.
 *
 * Backend requirements:
 *   memory  — no infrastructure needed (default)
 *   sqlite  — in-memory SQLite via bun:sqlite (no file, no Docker)
 *   mongo   — requires MongoDB (Docker or external, MONGO_URL env var)
 *   postgres — requires PostgreSQL (Docker or external, TEST_POSTGRES_URL env var)
 *
 * Usage:
 *   TEST_BACKEND=memory bun run test:e2e          # explicit memory (same as default)
 *   TEST_BACKEND=sqlite bun run test:e2e          # SQLite for all stores
 *   SLINGSHOT_E2E_AUTH_BACKEND=mongo SLINGSHOT_E2E_SESSION_BACKEND=redis bun run test:e2e:ci
 */
import type { DbConfig } from '../../../src/app';
import { resolveTestPostgresUrl } from './postgres';

export type BackendName = 'memory' | 'sqlite' | 'mongo' | 'postgres';

type StoreType = 'memory' | 'sqlite' | 'mongo' | 'redis' | 'postgres';

/**
 * Resolve the global default backend from TEST_BACKEND env var.
 */
export function resolveTestBackend(): BackendName {
  return (process.env.TEST_BACKEND as BackendName) || 'memory';
}

/**
 * Resolve a specific store backend, with per-store env var overriding the global default.
 */
function resolveStore(envVar: string, fallback: StoreType): StoreType {
  const value = process.env[envVar];
  if (value) return value as StoreType;
  return fallback;
}

/**
 * Map a BackendName to the default StoreType for session/cache stores.
 * Postgres doesn't have session/cache adapters — falls back to memory.
 */
function backendToStoreType(backend: BackendName): StoreType {
  switch (backend) {
    case 'memory':
      return 'memory';
    case 'sqlite':
      return 'sqlite';
    case 'mongo':
      return 'mongo';
    case 'postgres':
      return 'postgres';
    default:
      throw new Error(`Unknown test backend: ${backend}`);
  }
}

/**
 * Map a BackendName to the auth adapter store type.
 */
function backendToAuthType(backend: BackendName): 'memory' | 'sqlite' | 'mongo' | 'postgres' {
  switch (backend) {
    case 'memory':
      return 'memory';
    case 'sqlite':
      return 'sqlite';
    case 'mongo':
      return 'mongo';
    case 'postgres':
      return 'postgres';
    default:
      throw new Error(`Unknown test backend: ${backend}`);
  }
}

/**
 * Build a DbConfig from environment variables.
 *
 * The returned config can be spread into createTestFullServer() or
 * createTestHttpServer() overrides to switch the E2E storage backend.
 */
export function resolveTestDbConfig(): DbConfig {
  const globalBackend = resolveTestBackend();
  const globalStore = backendToStoreType(globalBackend);

  const sessions = resolveStore('SLINGSHOT_E2E_SESSION_BACKEND', globalStore);
  const cache = resolveStore('SLINGSHOT_E2E_CACHE_BACKEND', globalStore);
  const authEnv = process.env.SLINGSHOT_E2E_AUTH_BACKEND;
  const auth = authEnv
    ? backendToAuthType(authEnv as BackendName)
    : backendToAuthType(globalBackend);

  // Determine if mongo auto-connect is needed
  const needsMongo = sessions === 'mongo' || cache === 'mongo' || auth === 'mongo';

  // Determine if redis is needed
  const needsRedis = sessions === 'redis' || cache === 'redis';

  const config: DbConfig = {
    mongo: needsMongo ? ('single' as const) : (false as const),
    redis: needsRedis,
    sessions,
    cache,
    auth,
  };

  // SQLite uses in-memory database for tests — no file on disk
  if (sessions === 'sqlite' || cache === 'sqlite' || auth === 'sqlite') {
    config.sqlite = ':memory:';
  }
  if (sessions === 'postgres' || cache === 'postgres' || auth === 'postgres') {
    config.postgres = resolveTestPostgresUrl();
  }

  return config;
}

/**
 * Log the resolved backend config for debugging CI matrix runs.
 */
export function logTestBackend(): void {
  const backend = resolveTestBackend();
  const db = resolveTestDbConfig();
  console.log(
    `[E2E] Backend: ${backend} → sessions=${db.sessions} cache=${db.cache} auth=${db.auth} mongo=${db.mongo} redis=${db.redis}`,
  );
}
