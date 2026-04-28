/**
 * BullMQ adapter surface for Slingshot orchestration.
 */
export {
  classifyOrchestrationError,
  createBullMQOrchestrationAdapter,
  OrchestrationAdapterDisposedError,
  type BullMQOrchestrationAdapterMetrics,
  type BullMQOrchestrationMetricsCapability,
  type ErrorClassification,
} from './adapter';
/**
 * Map BullMQ run states into portable Slingshot orchestration statuses.
 */
export { mapBullMQStatus } from './statusMap';
/**
 * Create the task processor used by BullMQ activity-style task workers.
 */
export { createBullMQTaskProcessor } from './taskWorker';
/**
 * Create the workflow processor used by BullMQ workflow workers.
 */
export { createBullMQWorkflowProcessor } from './workflowWorker';
/**
 * Runtime validation and option types for the BullMQ orchestration adapter.
 */
export {
  bullmqJobRetentionSchema,
  bullmqOrchestrationAdapterOptionsSchema,
  bullmqTlsOptionsSchema,
  type BullMQJobRetentionOptions,
  type BullMQOrchestrationAdapterOptions,
  type BullMQTlsOptions,
} from './validation';
