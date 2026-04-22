import type { ZodType } from 'zod';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ResolvedWorkflow,
  RetryPolicy,
  StepInputContext,
  StepOptions,
} from '../types';

/**
 * Provider-facing snapshot of task execution settings after normalization.
 */
export interface ProviderTaskManifest {
  readonly name: string;
  readonly retry: RetryPolicy;
  readonly timeout: number | undefined;
  readonly queue: string | undefined;
  readonly concurrency: number | undefined;
}

/**
 * Workflow lifecycle hooks exposed separately from the structural manifest.
 */
export interface ProviderWorkflowHooks<TInput = unknown, TOutput = unknown> {
  readonly onStart?: ResolvedWorkflow<TInput, TOutput>['onStart'];
  readonly onComplete?: ResolvedWorkflow<TInput, TOutput>['onComplete'];
  readonly onFail?: ResolvedWorkflow<TInput, TOutput>['onFail'];
}

/**
 * Provider-facing representation of a workflow task step.
 */
export interface ProviderStepManifest<TWorkflowInput = unknown> {
  readonly _tag: 'Step';
  readonly name: string;
  readonly task: string;
  readonly options: StepOptions<TWorkflowInput>;
}

/**
 * Provider-facing representation of a parallel step group.
 */
export interface ProviderParallelManifest<TWorkflowInput = unknown> {
  readonly _tag: 'Parallel';
  readonly steps: readonly ProviderStepManifest<TWorkflowInput>[];
}

/**
 * Provider-facing representation of a workflow sleep entry.
 */
export interface ProviderSleepManifest<TWorkflowInput = unknown> {
  readonly _tag: 'Sleep';
  readonly name: string;
  readonly duration: number | ((ctx: StepInputContext<TWorkflowInput>) => number);
}

/**
 * Any workflow entry shape exposed through the provider registry.
 */
export type ProviderWorkflowEntry<TWorkflowInput = unknown> =
  | ProviderStepManifest<TWorkflowInput>
  | ProviderParallelManifest<TWorkflowInput>
  | ProviderSleepManifest<TWorkflowInput>;

/**
 * Provider-facing normalized workflow manifest with referenced task manifests inlined.
 */
export interface ProviderWorkflowManifest<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string | undefined;
  readonly input: ZodType<TInput>;
  readonly output: ZodType<TOutput> | undefined;
  readonly outputMapper?: (results: Record<string, unknown>) => TOutput;
  readonly steps: readonly ProviderWorkflowEntry<TInput>[];
  readonly timeout: number | undefined;
  readonly tasks: Readonly<Record<string, ProviderTaskManifest>>;
  readonly hooks: {
    readonly onStart: boolean;
    readonly onComplete: boolean;
    readonly onFail: boolean;
  };
}

/**
 * Read-only registry used by provider adapters and worker bootstraps to inspect
 * the normalized task and workflow catalog.
 */
export interface OrchestrationProviderRegistry {
  hasTask(name: string): boolean;
  getTask(name: string): AnyResolvedTask;
  getTaskManifest(name: string): ProviderTaskManifest;
  listTasks(): readonly AnyResolvedTask[];
  listTaskManifests(): readonly ProviderTaskManifest[];

  hasWorkflow(name: string): boolean;
  getWorkflow(name: string): AnyResolvedWorkflow;
  getWorkflowManifest(name: string): ProviderWorkflowManifest;
  getWorkflowHooks(name: string): ProviderWorkflowHooks;
  listWorkflows(): readonly AnyResolvedWorkflow[];
}
