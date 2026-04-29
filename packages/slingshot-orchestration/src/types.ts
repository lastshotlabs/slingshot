import type { ZodType } from 'zod';

/**
 * Retry policy shared by tasks and step-level overrides.
 */
export interface RetryPolicy {
  maxAttempts: number;
  backoff?: 'fixed' | 'exponential';
  delayMs?: number;
  maxDelayMs?: number;
}

/**
 * Minimal logger shape exposed to task handlers.
 */
export interface SlingshotLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Execution context passed to each task invocation.
 */
export interface TaskContext {
  attempt: number;
  runId: string;
  signal: AbortSignal;
  log: SlingshotLogger;
  tenantId?: string;
  reportProgress(data: { percent?: number; message?: string; [key: string]: unknown }): void;
}

type TaskHandler<TInput, TOutput> = {
  bivarianceHack(input: TInput, ctx: TaskContext): Promise<TOutput>;
}['bivarianceHack'];

type StepInputMapper<TWorkflowInput> = {
  bivarianceHack(ctx: StepInputContext<TWorkflowInput>): unknown;
}['bivarianceHack'];

type StepCondition<TWorkflowInput> = {
  bivarianceHack(ctx: StepInputContext<TWorkflowInput>): boolean;
}['bivarianceHack'];

type StepDurationMapper<TWorkflowInput> = {
  bivarianceHack(ctx: StepInputContext<TWorkflowInput>): number;
}['bivarianceHack'];

type WorkflowStartHookFn<TInput> = {
  bivarianceHack(ctx: { runId: string; input: TInput; tenantId?: string }): Promise<void> | void;
}['bivarianceHack'];

type WorkflowCompleteHookFn<TOutput> = {
  bivarianceHack(ctx: {
    runId: string;
    output: TOutput;
    durationMs: number;
    tenantId?: string;
  }): Promise<void> | void;
}['bivarianceHack'];

type WorkflowFailHookFn = {
  bivarianceHack(ctx: {
    runId: string;
    error: Error;
    failedStep?: string;
    tenantId?: string;
  }): Promise<void> | void;
}['bivarianceHack'];

/**
 * Per-hook configuration. When passed as a function the hook defaults to halt-on-error
 * (`continueOnHookError: false`). Pass an object form to opt into resilient hooks.
 */
export type WorkflowStartHook<TInput> =
  | WorkflowStartHookFn<TInput>
  | { handler: WorkflowStartHookFn<TInput>; continueOnHookError?: boolean };

export type WorkflowCompleteHook<TOutput> =
  | WorkflowCompleteHookFn<TOutput>
  | { handler: WorkflowCompleteHookFn<TOutput>; continueOnHookError?: boolean };

export type WorkflowFailHook =
  | WorkflowFailHookFn
  | { handler: WorkflowFailHookFn; continueOnHookError?: boolean };

/**
 * User-authored task definition before normalization.
 */
export interface TaskDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  handler: TaskHandler<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: number;
  queue?: string;
  concurrency?: number;
}

/**
 * Normalized frozen task definition registered with adapters and runtimes.
 */
export interface ResolvedTask<TInput = unknown, TOutput = unknown> {
  readonly _tag: 'ResolvedTask';
  readonly name: string;
  readonly description: string | undefined;
  readonly input: ZodType<TInput>;
  readonly output: ZodType<TOutput>;
  readonly handler: TaskHandler<TInput, TOutput>;
  readonly retry: RetryPolicy;
  readonly timeout: number | undefined;
  readonly queue: string | undefined;
  readonly concurrency: number | undefined;
}

/**
 * Convenience alias for APIs that accept any resolved task regardless of its
 * input/output generics.
 */
export type AnyResolvedTask = ResolvedTask<unknown, unknown>;

/**
 * Pure data available to step mappers and conditions.
 */
export interface StepInputContext<TWorkflowInput = unknown> {
  workflowInput: TWorkflowInput;
  results: Record<string, unknown>;
}

/**
 * Optional per-step behavior overrides applied inside a workflow.
 */
export interface StepOptions<TWorkflowInput = unknown> {
  input?: StepInputMapper<TWorkflowInput>;
  condition?: StepCondition<TWorkflowInput>;
  retry?: RetryPolicy;
  timeout?: number;
  continueOnFailure?: boolean;
  /**
   * Optional explicit step dependencies used for DAG-style authoring. Slingshot
   * detects cycles eagerly in `defineWorkflow()` so authoring-time bugs surface
   * immediately. When omitted the workflow steps execute in array order.
   */
  dependsOn?: readonly string[];
}

/**
 * A single workflow step that dispatches a task.
 */
export interface StepEntry<TWorkflowInput = unknown> {
  readonly _tag: 'Step';
  readonly name: string;
  readonly task: string;
  readonly taskRef?: AnyResolvedTask;
  readonly options: StepOptions<TWorkflowInput>;
}

/**
 * A group of workflow steps that execute concurrently.
 */
export interface ParallelEntry<TWorkflowInput = unknown> {
  readonly _tag: 'Parallel';
  readonly steps: readonly StepEntry<TWorkflowInput>[];
}

/**
 * A durable timer entry inside a workflow definition.
 */
export interface SleepEntry<TWorkflowInput = unknown> {
  readonly _tag: 'Sleep';
  readonly name: string;
  readonly duration: number | StepDurationMapper<TWorkflowInput>;
}

/**
 * Any entry that can appear in a workflow step list.
 */
export type WorkflowEntry<TWorkflowInput = unknown> =
  | StepEntry<TWorkflowInput>
  | ParallelEntry<TWorkflowInput>
  | SleepEntry<TWorkflowInput>;

/**
 * User-authored workflow definition before normalization.
 */
export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  input: ZodType<TInput>;
  output?: ZodType<TOutput>;
  outputMapper?: (results: Record<string, unknown>) => TOutput;
  steps: WorkflowEntry<TInput>[];
  timeout?: number;
  onStart?: WorkflowStartHook<TInput>;
  onComplete?: WorkflowCompleteHook<TOutput>;
  onFail?: WorkflowFailHook;
}

/**
 * Normalized frozen workflow definition registered with adapters and runtimes.
 */
export interface ResolvedWorkflow<TInput = unknown, TOutput = unknown> {
  readonly _tag: 'ResolvedWorkflow';
  readonly name: string;
  readonly description: string | undefined;
  readonly input: ZodType<TInput>;
  readonly output: ZodType<TOutput> | undefined;
  readonly outputMapper?: (results: Record<string, unknown>) => TOutput;
  readonly steps: readonly WorkflowEntry<TInput>[];
  readonly timeout: number | undefined;
  readonly onStart?: WorkflowDefinition<TInput, TOutput>['onStart'];
  readonly onComplete?: WorkflowDefinition<TInput, TOutput>['onComplete'];
  readonly onFail?: WorkflowDefinition<TInput, TOutput>['onFail'];
}

/**
 * Convenience alias for APIs that accept any resolved workflow regardless of
 * its input/output generics.
 */
export type AnyResolvedWorkflow = ResolvedWorkflow<unknown, unknown>;

/**
 * Portable run lifecycle states used across adapters and HTTP responses.
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

/**
 * Portable progress payload exposed by `reportProgress()` and `onProgress()`.
 */
export interface RunProgress {
  percent?: number;
  message?: string;
  [key: string]: unknown;
}

/**
 * Serializable run failure payload returned by adapters.
 */
export interface RunError {
  message: string;
  stack?: string;
}

/**
 * Portable task or workflow run snapshot.
 */
export interface Run {
  id: string;
  type: 'task' | 'workflow';
  name: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: RunError;
  tenantId?: string;
  priority?: number;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  progress?: RunProgress;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Per-step execution snapshot attached to workflow runs.
 */
export interface StepRun {
  name: string;
  task: string;
  status: RunStatus;
  output?: unknown;
  error?: RunError;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
}

/**
 * Workflow run snapshot that includes step state.
 */
export interface WorkflowRun extends Run {
  type: 'workflow';
  steps?: Record<string, StepRun>;
}

/**
 * Handle returned when a task or workflow run is started.
 */
export interface RunHandle<TOutput = unknown> {
  id: string;
  result(): Promise<TOutput>;
}

/**
 * Stable machine-readable orchestration error codes.
 */
export type OrchestrationErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_WORKFLOW'
  | 'TASK_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'VALIDATION_FAILED'
  | 'ADAPTER_ERROR'
  | 'PAYLOAD_TOO_LARGE';

/**
 * Portable run options understood by all adapters.
 */
export interface RunOptions {
  idempotencyKey?: string;
  delay?: number;
  tenantId?: string;
  priority?: number;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  adapterHints?: Record<string, unknown>;
}

/**
 * Portable schedule descriptor returned by scheduling-capable adapters.
 */
export interface ScheduleHandle {
  id: string;
  target: { type: 'task' | 'workflow'; name: string };
  cron: string;
  input?: unknown;
  nextRunAt?: Date;
}

/**
 * Portable run-list filter used by observability-capable adapters.
 */
export interface RunFilter {
  type?: 'task' | 'workflow';
  name?: string;
  status?: RunStatus | RunStatus[];
  tenantId?: string;
  tags?: Record<string, string>;
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Required orchestration adapter contract implemented by all providers.
 */
/**
 * Outcome returned by `cancelRun()` describing whether cancellation was confirmed
 * by the underlying adapter. `confirmed` means the run was deleted/finalized.
 * `best-effort` means the cancel was issued but post-cancel verification could
 * not confirm the run is gone — the caller should treat the run as still
 * potentially executing until they observe a terminal state.
 */
export interface CancelOutcome {
  cancelStatus: 'confirmed' | 'best-effort';
  message?: string;
}

/**
 * Required orchestration adapter contract implemented by all providers.
 */
export interface CoreOrchestrationAdapter {
  registerTask(def: AnyResolvedTask): void;
  registerWorkflow(def: AnyResolvedWorkflow): void;
  runTask(name: string, input: unknown, opts?: RunOptions): Promise<RunHandle>;
  runWorkflow(name: string, input: unknown, opts?: RunOptions): Promise<RunHandle>;
  getRun(runId: string): Promise<Run | WorkflowRun | null>;
  cancelRun(runId: string): Promise<CancelOutcome | undefined>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Optional signal capability for adapters with in-flight workflow signaling.
 */
export interface SignalCapability {
  signal(runId: string, name: string, payload?: unknown): Promise<void>;
}

/**
 * Optional scheduling capability for adapters with durable recurring triggers.
 */
export interface ScheduleCapability {
  schedule(
    target: { type: 'task' | 'workflow'; name: string },
    cron: string,
    input?: unknown,
  ): Promise<ScheduleHandle>;
  unschedule(scheduleId: string): Promise<void>;
  listSchedules(): Promise<ScheduleHandle[]>;
}

/**
 * Optional observability capability for adapters that support run listing.
 */
export interface ObservabilityCapability {
  listRuns(filter?: RunFilter): Promise<{ runs: Run[]; total: number }>;
}

/**
 * Optional real-time progress subscription capability.
 */
export interface ProgressCapability {
  onProgress(runId: string, callback: (data: Run['progress']) => void): () => void;
}

/**
 * Full adapter contract made up of the required core surface plus any optional
 * capabilities an implementation chooses to support.
 */
export type OrchestrationAdapter = CoreOrchestrationAdapter &
  Partial<SignalCapability> &
  Partial<ScheduleCapability> &
  Partial<ObservabilityCapability> &
  Partial<ProgressCapability>;

/**
 * Lifecycle events emitted by the orchestration domain.
 */
export interface OrchestrationEventMap {
  'orchestration.task.started': {
    runId: string;
    task: string;
    input: unknown;
    tenantId?: string;
  };
  'orchestration.task.completed': {
    runId: string;
    task: string;
    output: unknown;
    durationMs: number;
    tenantId?: string;
  };
  'orchestration.task.failed': {
    runId: string;
    task: string;
    error: RunError;
    tenantId?: string;
    permanent?: boolean;
  };
  'orchestration.workflow.started': {
    runId: string;
    workflow: string;
    input: unknown;
    tenantId?: string;
  };
  'orchestration.workflow.completed': {
    runId: string;
    workflow: string;
    output: unknown;
    durationMs: number;
    tenantId?: string;
  };
  'orchestration.workflow.failed': {
    runId: string;
    workflow: string;
    error: RunError;
    failedStep?: string;
    tenantId?: string;
  };
  'orchestration.step.completed': {
    runId: string;
    workflow: string;
    step: string;
    output: unknown;
  };
  'orchestration.step.failed': {
    runId: string;
    workflow: string;
    step: string;
    error: RunError;
  };
  'orchestration.step.skipped': {
    runId: string;
    workflow: string;
    step: string;
  };
  'orchestration.task.progress': {
    runId: string;
    task: string;
    data: RunProgress;
  };
  'orchestration.workflow.hookError': {
    runId: string;
    workflow: string;
    hook: 'onStart' | 'onComplete' | 'onFail';
    error: RunError;
  };
  'orchestration.task.postReturnError': {
    runId: string;
    task: string;
    error: RunError;
    tenantId?: string;
  };
  'orchestration.bullmq.snapshotMalformed': {
    runId: string;
    malformedKey: string;
    error: {
      message: string;
    };
  };
}

/**
 * Port used by the orchestration domain to emit lifecycle events without depending
 * on Slingshot's concrete event-bus implementation.
 */
export interface OrchestrationEventSink {
  emit<TName extends keyof OrchestrationEventMap>(
    name: TName,
    payload: OrchestrationEventMap[TName],
  ): void | Promise<void>;
}

/**
 * Feature flags checked with `runtime.supports(...)` before calling optional APIs.
 */
export type OrchestrationCapability = 'signals' | 'scheduling' | 'observability' | 'progress';

/**
 * Framework-agnostic runtime API used by application code.
 */
export interface OrchestrationRuntime {
  runTask<T extends AnyResolvedTask>(
    task: T,
    input: T extends ResolvedTask<infer TInput, unknown> ? TInput : never,
    opts?: RunOptions,
  ): Promise<RunHandle<T extends ResolvedTask<unknown, infer TOutput> ? TOutput : unknown>>;
  runTask(name: string, input: unknown, opts?: RunOptions): Promise<RunHandle>;

  runWorkflow<T extends AnyResolvedWorkflow>(
    workflow: T,
    input: T extends ResolvedWorkflow<infer TInput, unknown> ? TInput : never,
    opts?: RunOptions,
  ): Promise<RunHandle<T extends ResolvedWorkflow<unknown, infer TOutput> ? TOutput : unknown>>;
  runWorkflow(name: string, input: unknown, opts?: RunOptions): Promise<RunHandle>;

  getRun(runId: string): Promise<Run | WorkflowRun | null>;
  cancelRun(runId: string): Promise<CancelOutcome | undefined>;
  supports(capability: OrchestrationCapability): boolean;
  signal(runId: string, name: string, payload?: unknown): Promise<void>;
  schedule(
    target: { type: 'task' | 'workflow'; name: string },
    cron: string,
    input?: unknown,
  ): Promise<ScheduleHandle>;
  unschedule(scheduleId: string): Promise<void>;
  listSchedules(): Promise<ScheduleHandle[]>;
  listRuns(filter?: RunFilter): Promise<{ runs: Run[]; total: number }>;
  onProgress(runId: string, callback: (data: Run['progress']) => void): () => void;
}

/**
 * Inputs required to construct the portable orchestration runtime.
 */
export interface OrchestrationRuntimeOptions {
  adapter: OrchestrationAdapter;
  tasks: AnyResolvedTask[];
  workflows?: AnyResolvedWorkflow[];
  eventSink?: OrchestrationEventSink;
}
