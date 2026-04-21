import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ResolvedWorkflow,
} from '@lastshotlabs/slingshot-orchestration';

const taskRegistry = new Map<string, AnyResolvedTask>();
const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
const workflowHookRegistry = new Map<
  string,
  {
    onStart?: ResolvedWorkflow['onStart'];
    onComplete?: ResolvedWorkflow['onComplete'];
    onFail?: ResolvedWorkflow['onFail'];
  }
>();

let installed = false;

export function installWorkerRegistries(options: {
  tasks: readonly AnyResolvedTask[];
  workflows: readonly AnyResolvedWorkflow[];
}): void {
  if (installed) {
    throw new Error('Temporal worker registries are already installed in this process.');
  }

  taskRegistry.clear();
  workflowRegistry.clear();
  workflowHookRegistry.clear();

  for (const task of options.tasks) {
    taskRegistry.set(task.name, task);
  }
  for (const workflow of options.workflows) {
    workflowRegistry.set(workflow.name, workflow);
    workflowHookRegistry.set(workflow.name, {
      onStart: workflow.onStart,
      onComplete: workflow.onComplete,
      onFail: workflow.onFail,
    });
  }

  installed = true;
}

export function clearWorkerRegistries(): void {
  taskRegistry.clear();
  workflowRegistry.clear();
  workflowHookRegistry.clear();
  installed = false;
}

export function getRegisteredTask(name: string): AnyResolvedTask | undefined {
  return taskRegistry.get(name);
}

export function getRegisteredWorkflow(name: string): AnyResolvedWorkflow | undefined {
  return workflowRegistry.get(name);
}

export function getRegisteredWorkflowHooks(name: string):
  | {
      onStart?: ResolvedWorkflow['onStart'];
      onComplete?: ResolvedWorkflow['onComplete'];
      onFail?: ResolvedWorkflow['onFail'];
    }
  | undefined {
  return workflowHookRegistry.get(name);
}

export function isWorkerRegistryInstalled(): boolean {
  return installed;
}
