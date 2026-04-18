/**
 * Config-driven entity persistence — public API surface.
 *
 * This module exposes the full config-driven persistence layer: entity adapter
 * factories for every supported backend (memory, Redis, SQLite, Mongo, Postgres),
 * Zod schema generation, operation builders, multi-entity composition, and low-level
 * field utilities for custom adapter authors.
 *
 * **Typical usage** — let the framework wire everything for you:
 *
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-core';
 * import { createEntityFactories, generateSchemas } from '@lastshotlabs/slingshot';
 *
 * const Message = defineEntity('Message', {
 *   namespace: 'chat',
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     roomId:    field.string(),
 *     content:   field.string(),
 *     createdAt: field.date({ default: 'now' }),
 *   },
 * });
 *
 * // createEntityFactories returns a RepoFactories<EntityAdapter<...>> object.
 * // Pass it to resolveRepo() and the framework picks the right backend at startup.
 * const factories = createEntityFactories(Message);
 *
 * // Zod schemas for input validation and OpenAPI spec generation.
 * const schemas = generateSchemas(Message);
 * ```
 *
 * **Advanced usage** — individual adapter generators and operation builders:
 *
 * ```ts
 * import { createMongoEntityAdapter, defineOperations, op } from '@lastshotlabs/slingshot';
 *
 * const ops = defineOperations(Message, {
 *   byRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
 *   markRead: op.transition({ match: { id: 'param:id' }, field: 'status', from: 'unread', to: 'read' }),
 * });
 * ```
 *
 * **Exports grouped by concern:**
 * - **Orchestration**: `createEntityFactories`, `createCompositeFactories`
 * - **Per-backend adapters**: `createMemoryEntityAdapter`, `createRedisEntityAdapter`,
 *   `createSqliteEntityAdapter`, `createMongoEntityAdapter`, `createPostgresEntityAdapter`
 * - **Schema generation**: `generateSchemas`, `GeneratedSchemas`
 * - **Operations**: `defineOperations`, `op`, all `*OpConfig` types, `ResolvedOperations`
 * - **Field utilities**: `toSnakeCase`, `toCamelCase`, `applyDefaults`, `applyOnUpdate`,
 *   `encodeCursor`, `decodeCursor`
 */

// Entity factory orchestrator
export { createEntityFactories } from './createEntityFactories';

// Individual adapter generators (for advanced use / custom wiring)
export { createMemoryEntityAdapter } from './memoryAdapter';
export { createRedisEntityAdapter } from './redisAdapter';
export { createSqliteEntityAdapter } from './sqliteAdapter';
export { createMongoEntityAdapter } from './mongoAdapter';
export { createPostgresEntityAdapter } from './postgresAdapter';

// Zod schema generation
export { generateSchemas } from './schemaGen';
export type { GeneratedSchemas } from './schemaGen';

// Operations layer
export { defineOperations, op } from './operations';
export type {
  OperationConfig,
  LookupOpConfig,
  ExistsOpConfig,
  TransitionOpConfig,
  FieldUpdateOpConfig,
  AggregateOpConfig,
  ComputedAggregateOpConfig,
  BatchOpConfig,
  UpsertOpConfig,
  SearchOpConfig,
  CollectionOpConfig,
  ConsumeOpConfig,
  DeriveOpConfig,
  CustomOpConfig,
  ResolvedOperations,
  FilterExpression,
  FilterValue,
} from './operations';

// Multi-entity composition
export { createCompositeFactories } from './composition';

// Field utilities (public — useful for custom adapter authors)
export {
  toSnakeCase,
  toCamelCase,
  applyDefaults,
  applyOnUpdate,
  encodeCursor,
  decodeCursor,
} from './fieldUtils';
