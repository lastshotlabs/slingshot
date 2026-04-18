import type { RepoFactories } from '@lastshotlabs/slingshot-core';
import { createMemorySessionRepository } from './memoryStore';
import { createMongoSessionRepository } from './mongoStore';
import { createPostgresSessionRepository } from './postgresStore';
import { createRedisSessionRepository } from './redisStore';
import type { SessionRepository } from './repository';
import { createSqliteSessionRepository } from './sqliteStore';

/**
 * `RepoFactories` dispatch map for `SessionRepository`.
 *
 * Passed to `resolveRepo(sessionFactories, storeType, infra)` in the bootstrap layer
 * to instantiate the correct backend based on the configured `db.sessions` store type.
 *
 * Supported store types: `'memory'` | `'sqlite'` | `'redis'` | `'mongo'` | `'postgres'`.
 *
 * @example
 * import { sessionFactories } from '@lastshotlabs/slingshot-auth';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const sessionRepo = resolveRepo(sessionFactories, 'redis', storeInfra);
 */
export const sessionFactories: RepoFactories<SessionRepository> = {
  memory: () => createMemorySessionRepository(),
  sqlite: infra => createSqliteSessionRepository(infra.getSqliteDb()),
  redis: infra => createRedisSessionRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoSessionRepository(conn, mg);
  },
  postgres: infra => createPostgresSessionRepository(infra.getPostgres().pool),
};
