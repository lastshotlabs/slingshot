/**
 * Create the Temporal-backed orchestration adapter used by Slingshot servers.
 */
export {
  createTemporalOrchestrationAdapter,
  type TemporalOrchestrationHealthCapability,
} from './adapter';
/**
 * Create a Temporal worker supervisor for Slingshot task and workflow definitions.
 */
export { createTemporalOrchestrationWorker } from './worker';
/**
 * Generate a definitions module for handlers-directory based Temporal worker bootstraps.
 */
export { generateDirectoryDefinitionsModule } from './workflowModuleGenerator';
/**
 * Runtime validation helpers and public option types for Temporal adapter and worker setup.
 */
export {
  temporalAdapterOptionsSchema,
  temporalConnectionConfigSchema,
  temporalWorkerOptionsSchema,
  type TemporalConnectionConfig,
  type TemporalOrchestrationAdapterOptions,
  type TemporalOrchestrationWorkerOptions,
} from './validation';
/**
 * Map Temporal workflow execution states into portable Slingshot run statuses.
 */
export { mapTemporalStatus } from './statusMap';
/**
 * Build and encode Temporal visibility/search-attribute payloads for Slingshot runs.
 */
export {
  buildSearchAttributes,
  buildVisibilityQuery,
  encodeTag,
  encodeTags,
} from './searchAttributes';
/**
 * Derive the deterministic Temporal workflow ID used for a portable Slingshot run.
 */
export { deriveTemporalRunId } from './ids';
/**
 * Temporal-specific error classes and Temporal-to-portable error mapping.
 */
export {
  TemporalConnectionError,
  TemporalOrchestrationError,
  mapTemporalFailure,
  toRunError,
  wrapTemporalError,
} from './errors';
