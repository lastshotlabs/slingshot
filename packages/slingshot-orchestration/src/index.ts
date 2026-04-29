/**
 * Portable orchestration surface for tasks, workflows, and built-in adapters.
 */
export { OrchestrationError } from './errors';
/**
 * Error raised when a workflow lifecycle hook fails.
 */
export { WorkflowHookError } from './engine/workflowRunner';
/**
 * Define a portable orchestration task with typed input, output, and handler logic.
 */
export { defineTask } from './defineTask';
/**
 * Define workflows and compose portable workflow steps, sleeps, and parallel branches.
 */
export { defineWorkflow, parallel, sleep, step, stepResult } from './defineWorkflow';
/**
 * Create the runtime wrapper that executes tasks and workflows against a selected adapter.
 */
export { createOrchestrationRuntime } from './runtime';
/**
 * Create the in-memory orchestration adapter for local development and tests.
 */
export { createMemoryAdapter } from './adapters/memory';
/**
 * Create the SQLite-backed orchestration adapter for durable single-node execution.
 */
export { createSqliteAdapter } from './adapters/sqlite';
/**
 * Shared run-handle helpers for adapter implementations and consumers.
 */
export { createCachedRunHandle, generateRunId } from './adapter';
/**
 * Shared idempotency key scoping helper used by adapter implementations.
 */
export { createIdempotencyScope } from './idempotency';
/**
 * Public task, workflow, adapter, run, and capability types for the portable orchestration layer.
 */
export type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  CancelOutcome,
  CoreOrchestrationAdapter,
  ObservabilityCapability,
  OrchestrationAdapter,
  OrchestrationCapability,
  OrchestrationEventMap,
  OrchestrationEventSink,
  OrchestrationRuntime,
  OrchestrationRuntimeOptions,
  ParallelEntry,
  ProgressCapability,
  ResolvedTask,
  ResolvedWorkflow,
  RetryPolicy,
  Run,
  RunError,
  RunFilter,
  RunHandle,
  RunOptions,
  RunProgress,
  RunStatus,
  ScheduleCapability,
  ScheduleHandle,
  SignalCapability,
  SleepEntry,
  SlingshotLogger,
  StepEntry,
  StepInputContext,
  StepOptions,
  StepRun,
  TaskContext,
  TaskDefinition,
  WorkflowDefinition,
  WorkflowEntry,
  WorkflowRun,
} from './types';
