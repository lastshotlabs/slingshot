import { OrchestrationError, type AnyResolvedTask, type AnyResolvedWorkflow } from '@lastshotlabs/slingshot-orchestration';

export interface DiscoveredOrchestrationDefinitions {
  tasks: AnyResolvedTask[];
  workflows: AnyResolvedWorkflow[];
}

function isResolvedTask(value: unknown): value is AnyResolvedTask {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag?: string })._tag === 'ResolvedTask'
  );
}

function isResolvedWorkflow(value: unknown): value is AnyResolvedWorkflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    (value as { _tag?: string })._tag === 'ResolvedWorkflow'
  );
}

function registerUnique<T extends { name: string }>(bucket: Map<string, T>, value: T, kind: string): void {
  if (bucket.has(value.name)) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Duplicate discovered orchestration ${kind} '${value.name}'.`,
    );
  }
  bucket.set(value.name, value);
}

function collectNamedValues(bucket: Map<string, AnyResolvedTask | AnyResolvedWorkflow>, value: unknown, kind: 'task' | 'workflow'): void {
  if (typeof value !== 'object' || value === null) return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (kind === 'task' && isResolvedTask(item)) {
      registerUnique(bucket as Map<string, AnyResolvedTask>, item, kind);
    }
    if (kind === 'workflow' && isResolvedWorkflow(item)) {
      registerUnique(bucket as Map<string, AnyResolvedWorkflow>, item, kind);
    }
  }
}

export function discoverOrchestrationDefinitions(
  mod: Record<string, unknown>,
): DiscoveredOrchestrationDefinitions {
  const tasks = new Map<string, AnyResolvedTask>();
  const workflows = new Map<string, AnyResolvedWorkflow>();

  for (const [name, value] of Object.entries(mod)) {
    if (isResolvedTask(value)) {
      registerUnique(tasks, value, 'task');
      continue;
    }
    if (isResolvedWorkflow(value)) {
      registerUnique(workflows, value, 'workflow');
      continue;
    }
    if (name === 'tasks') {
      collectNamedValues(tasks as Map<string, AnyResolvedTask | AnyResolvedWorkflow>, value, 'task');
      continue;
    }
    if (name === 'workflows') {
      collectNamedValues(
        workflows as Map<string, AnyResolvedTask | AnyResolvedWorkflow>,
        value,
        'workflow',
      );
    }
  }

  return {
    tasks: [...tasks.values()],
    workflows: [...workflows.values()],
  };
}

function collectWorkflowTaskNames(workflows: readonly AnyResolvedWorkflow[]): Set<string> {
  const names = new Set<string>();
  for (const workflow of workflows) {
    for (const entry of workflow.steps) {
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
  }
  return names;
}

export function selectOrchestrationDefinitions(
  discovered: DiscoveredOrchestrationDefinitions,
  options: { taskNames?: readonly string[]; workflowNames?: readonly string[] },
): DiscoveredOrchestrationDefinitions {
  const taskMap = new Map(discovered.tasks.map(task => [task.name, task] as const));
  const workflowMap = new Map(discovered.workflows.map(workflow => [workflow.name, workflow] as const));

  const selectedWorkflows =
    options.workflowNames && options.workflowNames.length > 0
      ? options.workflowNames.map(name => {
          const workflow = workflowMap.get(name);
          if (!workflow) {
            throw new OrchestrationError('INVALID_CONFIG', `Workflow '${name}' not found in definitions module.`);
          }
          return workflow;
        })
      : discovered.workflows;

  const selectedTasks = new Map<string, AnyResolvedTask>();
  const workflowTaskNames = collectWorkflowTaskNames(selectedWorkflows);
  for (const taskName of workflowTaskNames) {
    const task = taskMap.get(taskName);
    if (!task) {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        `Workflow task dependency '${taskName}' was not found in definitions module.`,
      );
    }
    selectedTasks.set(task.name, task);
  }

  if (options.taskNames && options.taskNames.length > 0) {
    for (const taskName of options.taskNames) {
      const task = taskMap.get(taskName);
      if (!task) {
        throw new OrchestrationError('INVALID_CONFIG', `Task '${taskName}' not found in definitions module.`);
      }
      selectedTasks.set(task.name, task);
    }
  } else if (selectedWorkflows.length === 0) {
    for (const task of discovered.tasks) {
      selectedTasks.set(task.name, task);
    }
  }

  return {
    tasks: [...selectedTasks.values()],
    workflows: selectedWorkflows,
  };
}
