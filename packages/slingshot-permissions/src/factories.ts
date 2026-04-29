import type { PermissionsAdapter, StoreInfra } from '@lastshotlabs/slingshot-core';
import { createMemoryPermissionsAdapter } from './adapters/memory';
import { createMongoPermissionsAdapter } from './adapters/mongo';
import { createPermissionsPostgresAdapter } from './adapters/postgres';
import { createSqlitePermissionsAdapter } from './adapters/sqlite';

function unsupportedRedisPermissionsAdapter(_infra?: StoreInfra): never {
  throw new Error(
    '[slingshot-permissions] Redis permissions adapter is not implemented. Use memory, sqlite, mongo, or postgres instead.',
  );
}

/**
 * A record that maps every `StoreType` to a factory function producing a
 * `PermissionsAdapter` from `StoreInfra`. Pass to the framework's adapter resolution
 * machinery so the correct backend is selected at startup.
 *
 * @remarks
 * `redis` is rejected because there is no Redis permissions adapter.
 */
export type PermissionsAdapterFactories = Record<
  import('@lastshotlabs/slingshot-core').StoreType,
  (infra: StoreInfra) => PermissionsAdapter | Promise<PermissionsAdapter>
>;

/**
 * Pre-built `PermissionsAdapterFactories` covering all supported store types.
 *
 * Pass this to your framework's adapter resolution call to automatically select the
 * correct permissions backend based on the configured `storeType`.
 *
 * @example
 * ```ts
 * import { permissionsAdapterFactories } from '@lastshotlabs/slingshot-permissions';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const adapter = await resolveRepo(permissionsAdapterFactories, storeType, infra);
 * ```
 */
export const permissionsAdapterFactories = {
  memory: (_infra?: StoreInfra) => createMemoryPermissionsAdapter(),
  redis: (_infra?: StoreInfra) => unsupportedRedisPermissionsAdapter(_infra),
  sqlite: infra => createSqlitePermissionsAdapter(infra.getSqliteDb()),
  mongo: infra => {
    const { conn } = infra.getMongo();
    return createMongoPermissionsAdapter(conn);
  },
  postgres: infra => createPermissionsPostgresAdapter(infra.getPostgres().pool),
} satisfies PermissionsAdapterFactories;
