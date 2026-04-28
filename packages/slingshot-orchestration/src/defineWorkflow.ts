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

  if (options?.dependsOn !== undefined) {
    if (!Array.isArray(options.dependsOn)) {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        `Step '${stepName}' dependsOn must be an array of step names.`,
      );
    }
    for (const dep of options.dependsOn) {
      if (typeof dep !== 'string' || dep.length === 0) {
        throw new OrchestrationError(
          'INVALID_CONFIG',
          `Step '${stepName}' dependsOn entries must be non-empty strings.`,
        );
      }
      if (dep === stepName) {
        throw new OrchestrationError('INVALID_WORKFLOW', `Step '${stepName}' depends on itself.`);
      }
    }
  }

  return Object.freeze({
    input: options?.input,
    condition: options?.condition,
    retry: options?.retry ? normalizeRetryPolicy(options.retry, `Step '${stepName}'`) : undefined,
    timeout: options?.timeout,
    continueOnFailure: options?.continueOnFailure ?? false,
    dependsOn: options?.dependsOn ? Object.freeze([...options.dependsOn]) : undefined,
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
  // Build adjacency list of explicit dependsOn edges keyed by step name so we
  // can validate the DAG eagerly. Sleep entries can be referenced as
  // dependencies but never declare them themselves.
  const dependencyEdges = new Map<string, readonly string[]>();
  for (const entry of config.steps) {
    if (entry._tag === 'Step' || entry._tag === 'Sleep') {
      if (seen.has(entry.name)) {
        throw new OrchestrationError(
          'INVALID_CONFIG',
          `Workflow '${config.name}' contains duplicate step name '${entry.name}'.`,
        );
      }
      seen.add(entry.name);
      if (entry._tag === 'Step') {
        dependencyEdges.set(entry.name, entry.options.dependsOn ?? []);
      } else {
        dependencyEdges.set(entry.name, []);
      }
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
      dependencyEdges.set(child.name, child.options.dependsOn ?? []);
    }
  }

  // Validate that every dependsOn references a step that exists in the workflow.
  for (const [stepName, deps] of dependencyEdges) {
    for (const dep of deps) {
      if (!dependencyEdges.has(dep)) {
        throw new OrchestrationError(
          'INVALID_WORKFLOW',
          `Workflow '${config.name}' step '${stepName}' depends on unknown step '${dep}'.`,
        );
      }
    }
  }

  // Detect cycles via DFS. Iterative state machine so we don't blow the call
  // stack on deep dependency graphs.
  const cycle = findCycle(dependencyEdges);
  if (cycle) {
    throw new OrchestrationError(
      'INVALID_WORKFLOW',
      `Workflow '${config.name}' contains a dependency cycle: ${cycle.join(' -> ')}.`,
    );
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
 * Detect a dependency cycle using iterative DFS over the adjacency map. Returns
 * the cycle path (e.g. `['a', 'b', 'c', 'a']`) when one is found, or `undefined`
 * otherwise.
 */
function findCycle(edges: Map<string, readonly string[]>): string[] | undefined {
  const WHITE = 0; // unvisited
  const GRAY = 1; // on current DFS stack
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const node of edges.keys()) color.set(node, WHITE);

  for (const start of edges.keys()) {
    if (color.get(start) !== WHITE) continue;

    type Frame = { node: string; iter: Iterator<string> };
    const stack: Frame[] = [{ node: start, iter: (edges.get(start) ?? [])[Symbol.iterator]() }];
    color.set(start, GRAY);
    const path: string[] = [start];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const child = next.value;
      const childColor = color.get(child) ?? WHITE;
      if (childColor === GRAY) {
        // Found a back-edge: extract the cycle from path[child..end] + child.
        const cycleStart = path.indexOf(child);
        const cycleNodes = cycleStart >= 0 ? path.slice(cycleStart) : [child];
        cycleNodes.push(child);
        return cycleNodes;
      }
      if (childColor === WHITE) {
        color.set(child, GRAY);
        path.push(child);
        stack.push({ node: child, iter: (edges.get(child) ?? [])[Symbol.iterator]() });
      }
    }
  }
  return undefined;
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
