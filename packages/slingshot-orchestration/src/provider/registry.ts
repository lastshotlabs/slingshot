import { OrchestrationError } from '../errors';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  StepEntry,
  WorkflowEntry,
} from '../types';
import type {
  OrchestrationProviderRegistry,
  ProviderParallelManifest,
  ProviderStepManifest,
  ProviderTaskManifest,
  ProviderWorkflowEntry,
  ProviderWorkflowHooks,
  ProviderWorkflowManifest,
} from './types';

function registerUnique<T>(map: Map<string, T>, name: string, value: T, kind: string): void {
  if (map.has(name)) {
    throw new OrchestrationError('INVALID_CONFIG', `Duplicate orchestration ${kind} '${name}'.`);
  }
  map.set(name, value);
}

function requireEntry<T>(map: Map<string, T>, name: string, kind: string): T {
  const value = map.get(name);
  if (!value) {
    throw new OrchestrationError(
      kind === 'task' ? 'TASK_NOT_FOUND' : 'WORKFLOW_NOT_FOUND',
      `${kind === 'task' ? 'Task' : 'Workflow'} '${name}' not registered.`,
    );
  }
  return value;
}

function toTaskManifest(task: AnyResolvedTask): ProviderTaskManifest {
  return Object.freeze({
    name: task.name,
    retry: task.retry,
    timeout: task.timeout,
    queue: task.queue,
    concurrency: task.concurrency,
  });
}

function toProviderStep<TWorkflowInput>(entry: StepEntry<TWorkflowInput>): ProviderStepManifest<TWorkflowInput> {
  return Object.freeze({
    _tag: 'Step',
    name: entry.name,
    task: entry.task,
    options: entry.options,
  });
}

function toProviderEntry<TWorkflowInput>(
  entry: WorkflowEntry<TWorkflowInput>,
): ProviderWorkflowEntry<TWorkflowInput> {
  if (entry._tag === 'Step') {
    return toProviderStep(entry);
  }

  if (entry._tag === 'Parallel') {
    const steps = entry.steps.map(step => toProviderStep(step));
    return Object.freeze({
      _tag: 'Parallel',
      steps,
    } satisfies ProviderParallelManifest<TWorkflowInput>);
  }

  return Object.freeze({
    _tag: 'Sleep',
    name: entry.name,
    duration: entry.duration,
  });
}

function collectWorkflowTaskNames<TInput>(entries: readonly WorkflowEntry<TInput>[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry._tag === 'Step') {
      names.add(entry.taskRef?.name ?? entry.task);
      continue;
    }
    if (entry._tag === 'Parallel') {
      for (const step of entry.steps) {
        names.add(step.taskRef?.name ?? step.task);
      }
    }
  }
  return names;
}

function toWorkflowManifest(
  workflow: AnyResolvedWorkflow,
  taskManifests: Map<string, ProviderTaskManifest>,
): ProviderWorkflowManifest {
  const tasks = Object.fromEntries(
    [...collectWorkflowTaskNames(workflow.steps)].map(taskName => [
      taskName,
      requireEntry(taskManifests, taskName, 'task'),
    ]),
  );

  return Object.freeze({
    name: workflow.name,
    description: workflow.description,
    input: workflow.input,
    output: workflow.output,
    outputMapper: workflow.outputMapper,
    steps: workflow.steps.map(entry => toProviderEntry(entry)),
    timeout: workflow.timeout,
    tasks: Object.freeze(tasks),
    hooks: Object.freeze({
      onStart: Boolean(workflow.onStart),
      onComplete: Boolean(workflow.onComplete),
      onFail: Boolean(workflow.onFail),
    }),
  });
}

function toWorkflowHooks(workflow: AnyResolvedWorkflow): ProviderWorkflowHooks {
  return Object.freeze({
    onStart: workflow.onStart,
    onComplete: workflow.onComplete,
    onFail: workflow.onFail,
  });
}

export function createOrchestrationProviderRegistry(options: {
  tasks: readonly AnyResolvedTask[];
  workflows: readonly AnyResolvedWorkflow[];
}): OrchestrationProviderRegistry {
  const tasks = new Map<string, AnyResolvedTask>();
  const taskManifests = new Map<string, ProviderTaskManifest>();
  const workflows = new Map<string, AnyResolvedWorkflow>();
  const workflowManifests = new Map<string, ProviderWorkflowManifest>();
  const workflowHooks = new Map<string, ProviderWorkflowHooks>();

  for (const task of options.tasks) {
    registerUnique(tasks, task.name, task, 'task');
    registerUnique(taskManifests, task.name, toTaskManifest(task), 'task');
  }

  for (const workflow of options.workflows) {
    registerUnique(workflows, workflow.name, workflow, 'workflow');
  }

  for (const workflow of options.workflows) {
    workflowManifests.set(workflow.name, toWorkflowManifest(workflow, taskManifests));
    workflowHooks.set(workflow.name, toWorkflowHooks(workflow));
  }

  return {
    hasTask(name) {
      return tasks.has(name);
    },
    getTask(name) {
      return requireEntry(tasks, name, 'task');
    },
    getTaskManifest(name) {
      return requireEntry(taskManifests, name, 'task');
    },
    listTasks() {
      return Object.freeze([...tasks.values()]);
    },
    listTaskManifests() {
      return Object.freeze([...taskManifests.values()]);
    },
    hasWorkflow(name) {
      return workflows.has(name);
    },
    getWorkflow(name) {
      return requireEntry(workflows, name, 'workflow');
    },
    getWorkflowManifest(name) {
      return requireEntry(workflowManifests, name, 'workflow');
    },
    getWorkflowHooks(name) {
      return requireEntry(workflowHooks, name, 'workflow');
    },
    listWorkflows() {
      return Object.freeze([...workflows.values()]);
    },
  };
}
