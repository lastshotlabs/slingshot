/**
 * Entity seeder — config-driven fake data generation and persistence.
 *
 * @example
 * ```ts
 * import { createEntitySeeder, seedAll } from '@lastshotlabs/slingshot-entity/seeder';
 * ```
 *
 * @module
 */
export { createEntitySeeder, seedAll } from './createEntitySeeder';
export type {
  EntitySeeder,
  EntitySeederOptions,
  SeederAdapter,
  MultiSeederEntry,
  MultiSeederOptions,
  MultiSeederResult,
} from './createEntitySeeder';
export { topoSortEntities } from './topoSort';
