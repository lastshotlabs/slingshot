import { assertKebab, normalizeRetryPolicy } from './defineTask';
import { OrchestrationError } from './errors';
import type {
  AnyResolvedTask,
  ParallelEntry,
  ResolvedWorkflow,
  SleepEntry,
  StepEntry,
  StepOptions,
  WorkflowDefinition,
} from './types';

function freezeStepOptions<TWorkflowInput>(
  stepName: string,
  options: StepOptions<TWorkflowInput> | undefined,
): StepOptions<TWorkflowInput> {
  if (
    options?.timeout !== undefined &&
    (!Number.isFinite(options.timeout) || options.timeout <= 0)
  ) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Step '${stepName}' timeout must be a positive number.`,
    );
  }

  return Object.freeze({
    input: options?.input,
    condition: options?.condition,
    retry: options?.retry ? normalizeRetryPolicy(options.retry, `Step '${stepName}'`) : undefined,
    timeout: options?.timeout,
    continueOnFailure: options?.continueOnFailure ?? false,
  });
}

/**
 * Reference a task inside a workflow by object or public name.
 *
 * Prefer passing the resolved task object when authoring nearby code so refactors
 * stay type-safe. String names remain useful for cross-module composition.
 */
export function step<TWorkflowInput = unknown>(
  name: string,
  taskOrName: string | AnyResolvedTask,
  options?: StepOptions<TWorkflowInput>,
): StepEntry<TWorkflowInput> {
  assertKebab(name, 'Step');
  const taskName = typeof taskOrName === 'string' ? taskOrName : taskOrName.name;
  assertKebab(taskName, 'Task');
  return Object.freeze({
    _tag: 'Step' as const,
    name,
    task: taskName,
    taskRef: typeof taskOrName === 'string' ? undefined : taskOrName,
    options: freezeStepOptions(name, options),
  });
}

/**
 * Group multiple workflow steps so they execute concurrently.
 */
export function parallel<TWorkflowInput = unknown>(
  steps: StepEntry<TWorkflowInput>[],
): ParallelEntry<TWorkflowInput> {
  if (steps.length === 0) {
    throw new OrchestrationError('INVALID_CONFIG', 'parallel() requires at least one step.');
  }
  return Object.freeze({
    _tag: 'Parallel' as const,
    steps: Object.freeze([...steps]),
  });
}

/**
 * Insert a durable timer entry into a workflow definition.
 */
export function sleep<TWorkflowInput = unknown>(
  name: string,
  duration:
    | number
    | ((ctx: { workflowInput: TWorkflowInput; results: Record<string, unknown> }) => number),
): SleepEntry<TWorkflowInput> {
  assertKebab(name, 'Sleep step');
  if (typeof duration === 'number' && (!Number.isFinite(duration) || duration < 0)) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Sleep step '${name}' duration must be a non-negative finite number.`,
    );
  }
  return Object.freeze({
    _tag: 'Sleep' as const,
    name,
    duration,
  });
}

/**
 * Define an ordered workflow of steps, parallel groups, and sleep entries.
 *
 * Workflows are transport-neutral definitions. They are only executable after being
 * registered with `createOrchestrationRuntime()` or `createOrchestrationPlugin()`.
 */
export function defineWorkflow<TInput, TOutput>(
  config: WorkflowDefinition<TInput, TOutput>,
): ResolvedWorkflow<TInput, TOutput> {
  assertKebab(config.name, 'Workflow');
  if (!config.input) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Workflow '${config.name}' requires an input schema.`,
    );
  }
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Workflow '${config.name}' requires at least one step.`,
    );
  }
  if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Workflow '${config.name}' timeout must be a positive number.`,
    );
  }

  const seen = new Set<string>();
  for (const entry of config.steps) {
    if (entry._tag === 'Step' || entry._tag === 'Sleep') {
      if (seen.has(entry.name)) {
        throw new OrchestrationError(
          'INVALID_CONFIG',
          `Workflow '${config.name}' contains duplicate step name '${entry.name}'.`,
        );
      }
      seen.add(entry.name);
      continue;
    }

    for (const child of entry.steps) {
      if (seen.has(child.name)) {
        throw new OrchestrationError(
          'INVALID_CONFIG',
          `Workflow '${config.name}' contains duplicate step name '${child.name}'.`,
        );
      }
      seen.add(child.name);
    }
  }

  return Object.freeze({
    _tag: 'ResolvedWorkflow' as const,
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    outputMapper: config.outputMapper,
    steps: Object.freeze([...config.steps]),
    timeout: config.timeout,
    onStart: config.onStart,
    onComplete: config.onComplete,
    onFail: config.onFail,
  });
}

/**
 * Read a prior workflow step result with optional result typing.
 */
export function stepResult<TResult = unknown>(
  results: Record<string, unknown>,
  name: string,
  task?: AnyResolvedTask,
): TResult | undefined;
export function stepResult<TResult = unknown>(
  results: Record<string, unknown>,
  name: string,
): TResult | undefined {
  return results[name] as TResult | undefined;
}
