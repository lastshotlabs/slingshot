/**
 * @lastshotlabs/slingshot-entity
 *
 * Dev-time entity definition and code generation.
 *
 * - defineEntity() + field.*() — declare entity shapes
 * - defineOperations() + op.*() — declare custom operations
 * - generate() — pure function: definitions → source strings
 * - writeGenerated() — CLI wrapper: write generated files to disk
 */

// Entity definition API
/** Declare a config-driven entity that becomes the source of truth for fields, routes, and adapters. */
export { defineEntity } from './defineEntity';
/** Field builder DSL used when authoring entities in TypeScript. */
export { field } from './builders/field';
/** Index and relation helpers used by the entity definition DSL. */
export { index, relation } from './builders/entityHelpers';

// Operations definition API
/** Attach named config-driven operations to an entity definition. */
export { defineOperations } from './defineOperations';
/** Operation builder DSL for lookups, transitions, aggregates, mutations, and more. */
export { op } from './builders/op';

// Runtime config-driven entity factories
/** Runtime factories and helpers that turn entity config into live adapters and schemas. */
export {
  createEntityFactories,
  createMemoryEntityAdapter,
  createRedisEntityAdapter,
  createSqliteEntityAdapter,
  createMongoEntityAdapter,
  createPostgresEntityAdapter,
  generateSchemas,
  createCompositeFactories,
  toSnakeCase,
  toCamelCase,
  applyDefaults,
  applyOnUpdate,
  encodeCursor,
  decodeCursor,
} from './configDriven/index';
/** Runtime-generated schema bundle produced from resolved entity config. */
export type { GeneratedSchemas } from './configDriven/index';

// Types
/** Shared entity-definition, field, filter, and operation contracts re-exported for authoring. */
export type {
  // Field types
  FieldType,
  FieldDef,
  FieldOptions,
  AutoDefault,
  // Entity config
  IndexDef,
  RelationDef,
  SoftDeleteConfig,
  PaginationConfig,
  TenantConfig,
  EntityStorageHints,
  EntityTtlConfig,
  EntityConfig,
  ResolvedEntityConfig,
  // Filter types
  FilterExpression,
  FilterValue,
  FilterOperator,
  // Operation configs
  ComputeSpec,
  ComputedField,
  MergeStrategy,
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
  CollectionOperation,
  ConsumeOpConfig,
  DeriveOpConfig,
  DeriveSource,
  CustomOpConfig,
  IncrementOpConfig,
  OperationConfig,
  ResolvedOperations,
} from './types';

// Code generation
/** Pure code generator that turns entity definitions into source artifacts. */
export { generate } from './generate';
/** Generator options that control emitted files and runtime features. */
export type { GenerateOptions } from './generate';

// CLI / file writing
/** Write generated entity artifacts to disk from a Slingshot package or CLI flow. */
export { writeGenerated } from './cli';
/** File-output options for `writeGenerated()` and generator CLI integrations. */
export type { WriteOptions } from './cli';

// Audits
/** Audit an entity definition for structural issues and authoring risks. */
export { auditEntity } from './audits';
/** Audit result types surfaced by entity-definition linting and review tooling. */
export type { EntityAuditFinding, EntityAuditResult, AuditSeverity } from './audits';

// Entity manifest (JSON-driven definitions)
/** Manifest schemas and conversion helpers for JSON-driven entity authoring. */
export {
  entityManifestSchema,
  manifestEntitySchema,
  manifestEntitiesSchema,
  validateEntityManifest,
  multiEntityManifestSchema,
  createEntityHandlerRegistry,
  createEntityAdapterTransformRegistry,
  createEntityPluginHookRegistry,
  resolveEntityManifest,
  parseAndResolveEntityManifest,
  resolveMultiEntityManifest,
  parseAndResolveMultiEntityManifest,
  autoGrantConfigSchema,
  activityEventConfigSchema,
  activityLogConfigSchema,
  runtimeHookRefSchema,
  adapterTransformsSchema,
  manifestHooksSchema,
} from './manifest';
/** Manifest-driven entity authoring, registry, and hook contracts. */
export type {
  EntityManifest,
  ManifestEntity,
  ManifestEntities,
  ManifestField,
  ManifestOperation,
  ManifestCustomOpHttp,
  ManifestValidationResult,
  HandlerRef,
  RuntimeHookRef,
  MultiEntityManifest,
  ManifestCompositeEntry,
  ResolvedMultiEntityManifest,
  EntityHandlerRegistry,
  EntityAdapterTransform,
  EntityAdapterTransformContext,
  EntityAdapterTransformRegistry,
  EntityPluginAfterAdaptersContext,
  EntityPluginAfterAdaptersHook,
  EntityPluginHookRegistry,
  EntityManifestRuntime,
  EntityManifestConversionOptions,
  ResolvedManifest,
  AutoGrantConfig,
  ActivityEventConfig,
  ActivityLogConfig,
  ManifestHooks,
} from './manifest';

// Schema migrations
/** Diff entity schemas and generate storage-specific migration plans. */
export {
  diffEntityConfig,
  generateMigrations,
  generateMigrationSqlite,
  generateMigrationPostgres,
  generateMigrationMongo,
  loadSnapshot,
  saveSnapshot,
} from './migrations';
/** Schema diff and migration-plan result types for storage evolution workflows. */
export type { MigrationPlan, MigrationChange, EntitySnapshot } from './migrations';

// Validation (Zod schemas)
/** Validate entity and operation config before generation or runtime assembly. */
export {
  entityConfigSchema,
  createOperationValidator,
  validateEntityConfig,
  validateOperations,
} from './validation';
/** Validation result object returned by entity config checks. */
export type { ValidationResult } from './validation';

// App manifest → entity factory bridge
/** Convert app-manifest entity declarations into runtime entity configs. */
export { manifestToEntity, manifestEntitiesToConfigs } from './manifest/manifestToEntity';
/** Result types returned when converting manifest entities into runtime config. */
export type { ManifestEntityResult, ManifestEntitiesResult } from './manifest/manifestToEntity';
/** Convert runtime entity config back into the manifest representation. */
export {
  entityConfigToManifestEntry,
  fieldDefToManifestField,
  operationsToManifestOperations,
} from './manifest/entityConfigToManifest';

// Plugin factory
/** Build the entity plugin that mounts config-driven CRUD and operation routes. */
export { createEntityPlugin } from './createEntityPlugin';
/** Plugin config and runtime context types for `createEntityPlugin()`. */
export type {
  EntityPlugin,
  EntityPluginConfig,
  EntityPluginEntry,
  EntityPluginContext,
} from './createEntityPlugin';
/** Cross-plugin entity adapter publication and lookup helpers. */
export {
  maybeEntityAdapter,
  publishEntityAdaptersState,
  requireEntityAdapter,
} from '@lastshotlabs/slingshot-core';
/** Lookup contract for cross-plugin entity adapter access. */
export type { EntityAdapterLookup } from '@lastshotlabs/slingshot-core';

// Consumer shape hardening — system fields, storage fields, and storage conventions
/** Consumer-configurable entity system fields, storage field mapping, and storage convention types. */
export type {
  EntitySystemFields,
  ResolvedEntitySystemFields,
  EntityStorageFieldMap,
  ResolvedEntityStorageFieldMap,
  EntityStorageConventions,
  ResolvedEntityStorageConventions,
  CustomAutoDefaultResolver,
  CustomOnUpdateResolver,
} from '@lastshotlabs/slingshot-core';

// Channel config wiring
/** Wire entity channel config into runtime subscription and message handlers. */
export {
  buildSubscribeGuard,
  wireChannelForwarding,
  buildEntityReceiveHandlers,
} from './channels/applyChannelConfig';
/** Channel wiring dependencies and handler types for entity realtime declarations. */
export type {
  ChannelConfigDeps,
  ChannelMiddlewareHandler,
  WsPublishFn,
} from './channels/applyChannelConfig';

/** Evaluate route auth for config-driven entity routes against runtime dependencies. */
export {
  defineEntityExecutor,
  defineEntityRoute,
  evaluateRouteAuth,
  normalizeEntityRouteShape,
  planEntityRoutes,
  scoreEntityRouteSpecificity,
} from './routing';
/** Route-auth evaluation dependencies and result types for entity route assembly. */
export type {
  EvaluateRouteAuthDeps,
  RouteAuthResult,
  BareEntityAdapter,
  EntityExtraRoute,
  EntityRouteExecutorDefinition,
  EntityGeneratedRouteKey,
  EntityRouteExecutionContext,
  EntityRouteExecutor,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorBuilderContext,
  EntityRouteExecutorOverrides,
  PlannedEntityRoute,
} from './routing';
/** Package-first entity authoring builder and standard/custom wiring contracts. */
export { entity } from './packageAuthoring';
export type {
  EntityModuleWiring,
  FactoriesEntityModuleWiring,
  ManualEntityModuleWiring,
  PackageEntityAdapterFor,
  PackageEntityModule,
  PackageEntityModuleImplementation,
  StandardEntityModuleWiring,
} from './packageAuthoring';

// Policy hooks
/** Register and resolve entity policy hooks used by config-driven permission dispatch. */
export {
  registerEntityPolicy,
  getEntityPolicyResolver,
  freezeEntityPolicyRegistry,
} from './policy';
export { resolvePolicy, policyAppliesToOp, buildPolicyAction, safeReadJsonBody } from './policy';
export { definePolicyDispatch } from './policy';
/** Entity policy resolution and dispatch contracts used by permission-aware routes. */
export type { ResolvePolicyArgs, PolicyDispatchConfig } from './policy';
