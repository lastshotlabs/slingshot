// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-orchestration-bullmq/testing — Test utilities
// ---------------------------------------------------------------------------

/** Standard timeout for BullMQ orchestration adapter operations in tests. */
export const TEST_ADAPTER_TIMEOUT_MS = 10_000;

/** Classification helpers re-exported for test use. */
export { classifyOrchestrationError, type ErrorClassification } from './errorClassification';

/**
 * Shared in-memory BullMQ fakes for use in tests.
 *
 * These classes and helpers allow tests to exercise the orchestration adapter
 * without a real Redis server. Import them in test files, set up via
 * `mock.module('bullmq', () => createFakeBullMQModule())`, and assert against
 * static instance lists (`FakeQueue.instances`, `FakeWorker.instances`, etc.).
 */
export {
  FakeRedisClient,
  FakeJob,
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeBullMQModule,
  resetFakeBullMQState,
  type FakeJobState,
} from './testing/fakeBullMQ';
