// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-orchestration-bullmq/testing — Test utilities
// ---------------------------------------------------------------------------

/** Standard timeout for BullMQ orchestration adapter operations in tests. */
export const TEST_ADAPTER_TIMEOUT_MS = 10_000;

/** Classification helpers re-exported for test use. */
export { classifyOrchestrationError, type ErrorClassification } from './errorClassification';
