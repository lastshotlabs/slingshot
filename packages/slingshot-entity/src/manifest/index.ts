/**
 * Entity Manifest — JSON-driven entity + operations definitions.
 */

// Schema + validation
export {
  entityManifestSchema,
  manifestEntitySchema,
  manifestEntitiesSchema,
  validateEntityManifest,
  handlerRefSchema,
  runtimeHookRefSchema,
  autoGrantConfigSchema,
  activityEventConfigSchema,
  activityLogConfigSchema,
  adapterTransformsSchema,
  manifestHooksSchema,
} from './entityManifestSchema';
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
  AutoGrantConfig,
  ActivityEventConfig,
  ActivityLogConfig,
  ManifestHooks,
} from './entityManifestSchema';

// Multi-entity manifest
export {
  multiEntityManifestSchema,
  resolveMultiEntityManifest,
  parseAndResolveMultiEntityManifest,
} from './multiEntityManifest';
export type {
  MultiEntityManifest,
  ManifestCompositeEntry,
  ResolvedMultiEntityManifest,
} from './multiEntityManifest';

// Handler registry
export { createEntityHandlerRegistry } from './entityHandlerRegistry';
export type {
  EntityHandlerRegistry,
  HandlerFactory,
  BackendHandlers,
  HandlerEntry,
} from './entityHandlerRegistry';

// Adapter transforms + lifecycle hooks
export { createEntityAdapterTransformRegistry } from './entityAdapterTransformRegistry';
export type {
  EntityAdapterTransform,
  EntityAdapterTransformContext,
  EntityAdapterTransformRegistry,
} from './entityAdapterTransformRegistry';
export { createEntityPluginHookRegistry } from './entityPluginHookRegistry';
export type {
  EntityPluginAfterAdaptersContext,
  EntityPluginAfterAdaptersHook,
  EntityPluginHookRegistry,
} from './entityPluginHookRegistry';
export type { EntityManifestRuntime } from './entityManifestRuntime';

// Resolver
export { resolveEntityManifest, parseAndResolveEntityManifest } from './resolveManifest';
export type { ResolvedManifest } from './resolveManifest';

// App-manifest bridge (record-keyed entities → ResolvedEntityConfig)
export { manifestToEntity, manifestEntitiesToConfigs } from './manifestToEntity';
export type { ManifestEntityResult, ManifestEntitiesResult } from './manifestToEntity';
export {
  entityConfigToManifestEntry,
  fieldDefToManifestField,
  operationsToManifestOperations,
} from './entityConfigToManifest';
export type { EntityManifestConversionOptions } from './entityConfigToManifest';
