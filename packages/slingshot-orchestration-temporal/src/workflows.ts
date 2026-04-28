import { ApplicationFailure } from '@temporalio/common';
import {
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
  sleep as workflowSleep,
} from '@temporalio/workflow';
import type {
  AnyResolvedWorkflow,
  RunProgress,
  RunStatus,
  StepRun,
} from '@lastshotlabs/slingshot-orchestration';
import type { ProviderTaskManifest } from '@lastshotlabs/slingshot-orchestration/provider';
import type {
  EmitOrchestrationEventArgs,
  ExecuteSlingshotTaskArgs,
  ExecuteSlingshotTaskResult,
  ExecuteWorkflowHookArgs,
} from './activities';
import { toRunError } from './runError';

const stateQuery = defineQuery<{ progress?: RunProgress; steps?: Record<string, StepRun> }>(
  'slingshot-state',
);
const progressSignal =
  defineSignal<[payload: { stepName?: string; data: RunProgress }]>('slingshot-progress');
const userSignal = defineSignal<[payload: { name: string; payload?: unknown }]>('slingshot-signal');

interface TemporalTaskResultEnvelope {
  output: unknown;
  progress?: RunProgress;
}

interface TemporalWorkflowResultEnvelope {
  output: unknown;
  steps: Record<string, StepRun>;
  progress?: RunProgress;
}

interface TemporalFailureDetails {
  error: ReturnType<typeof toRunError>;
  failedStep?: string;
  steps?: Record<string, StepRun>;
  progress?: RunProgress;
}

type WorkflowManifestMap = Record<
  string,
  {
    workflow: AnyResolvedWorkflow;
    tasks: Record<string, ProviderTaskManifest>;
    hooks: {
      onStart: boolean;
      onComplete: boolean;
      onFail: boolean;
    };
  }
>;

interface SlingshotTaskWorkflowArgs {
  taskName: string;
  input: unknown;
  runId: string;
  tenantId?: string;
}

interface SlingshotWorkflowArgs {
  workflowName: string;
  input: unknown;
  runId: string;
  tenantId?: string;
}

function mergeTaskManifest(
  task: ProviderTaskManifest,
  options: { retry?: ProviderTaskManifest['retry']; timeout?: number } | undefined,
) {
  return {
    retry: {
      maxAttempts: options?.retry?.maxAttempts ?? task.retry.maxAttempts,
      backoff: options?.retry?.backoff ?? task.retry.backoff,
      delayMs: options?.retry?.delayMs ?? task.retry.delayMs,
      maxDelayMs: options?.retry?.maxDelayMs ?? task.retry.maxDelayMs,
    },
    timeout: options?.timeout ?? task.timeout ?? 86_400_000,
    queue: task.queue,
  };
}

function toTemporalRetry(task: ReturnType<typeof mergeTaskManifest>['retry']) {
  return {
    maximumAttempts: task.maxAttempts,
    initialInterval: task.delayMs ?? 1000,
    maximumInterval: task.maxDelayMs,
    backoffCoefficient: task.backoff === 'fixed' ? 1 : 2,
  };
}

function createTaskActivity(options: {
  queue: string | undefined;
  timeout: number;
  retry: ReturnType<typeof mergeTaskManifest>['retry'];
}) {
  return proxyActivities<{
    executeSlingshotTask(args: ExecuteSlingshotTaskArgs): Promise<ExecuteSlingshotTaskResult>;
  }>({
    taskQueue: options.queue,
    startToCloseTimeout: options.timeout,
    retry: toTemporalRetry(options.retry),
  }).executeSlingshotTask;
}

function createHookActivity() {
  return proxyActivities<{
    executeWorkflowHook(args: ExecuteWorkflowHookArgs): Promise<void>;
  }>({
    startToCloseTimeout: 60_000,
  }).executeWorkflowHook;
}

function createEventActivity() {
  return proxyActivities<{
    emitOrchestrationEvent(args: EmitOrchestrationEventArgs): Promise<void>;
  }>({
    startToCloseTimeout: 30_000,
  }).emitOrchestrationEvent;
}

function recordStepState(
  steps: Record<string, StepRun>,
  stepName: string,
  taskName: string,
  patch: Partial<StepRun>,
): void {
  const current = steps[stepName] ?? {
    name: stepName,
    task: taskName,
    status: 'pending' as RunStatus,
    attempts: 0,
  };
  steps[stepName] = {
    ...current,
    ...patch,
  };
}

export async function slingshotTaskWorkflowImpl(
  taskManifestMap: Record<string, ProviderTaskManifest>,
  args: SlingshotTaskWorkflowArgs,
): Promise<TemporalTaskResultEnvelope> {
  const taskManifest = taskManifestMap[args.taskName];
  if (!taskManifest) {
    throw ApplicationFailure.nonRetryable(
      `Task '${args.taskName}' is not registered.`,
      'SlingshotTaskFailure',
    );
  }

  let progress: RunProgress | undefined;

  setHandler(progressSignal, payload => {
    progress = payload.data;
  });
  setHandler(stateQuery, () => ({ progress }));

  const executeTask = createTaskActivity({
    queue: taskManifest.queue,
    timeout: taskManifest.timeout ?? 86_400_000,
    retry: mergeTaskManifest(taskManifest, undefined).retry,
  });

  try {
    const result = await executeTask({
      taskName: args.taskName,
      input: args.input,
      runId: args.runId,
      tenantId: args.tenantId,
      parentWorkflowId: workflowInfo().workflowId,
    });
    return {
      output: result.output,
      progress,
    };
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      'Slingshot task workflow failed',
      'SlingshotTaskFailure',
      {
        error: toRunError(error),
        progress,
      } satisfies TemporalFailureDetails,
    );
  }
}

export async function slingshotWorkflowImpl(
  workflowManifestMap: WorkflowManifestMap,
  args: SlingshotWorkflowArgs,
): Promise<TemporalWorkflowResultEnvelope> {
  const registration = workflowManifestMap[args.workflowName];
  if (!registration) {
    throw ApplicationFailure.nonRetryable(
      `Workflow '${args.workflowName}' is not registered.`,
      'SlingshotWorkflowFailure',
    );
  }

  const workflow = registration.workflow;
  const eventActivity = createEventActivity();
  const hookActivity = createHookActivity();
  const parsedInput = workflow.input.parse(args.input);
  const steps: Record<string, StepRun> = {};
  // Date.now() is deterministic inside Temporal workflows; the SDK sandbox patches it.
  const runStartedAtMs = Date.now();
  let progress: RunProgress | undefined;
  let failedStep: string | undefined;
  // Signals are buffered for the lifetime of the workflow so that workflow logic
  // (or external queries) can inspect them. To prevent unbounded memory growth,
  // we cap the buffer at 100 entries and drop the oldest when the cap is reached.
  const MAX_BUFFERED_SIGNALS = 100;
  const bufferedSignals: Array<{ name: string; payload?: unknown }> = [];

  setHandler(progressSignal, payload => {
    progress = payload.data;
  });
  setHandler(userSignal, payload => {
    if (bufferedSignals.length >= MAX_BUFFERED_SIGNALS) {
      bufferedSignals.shift(); // drop oldest to stay within cap
    }
    bufferedSignals.push(payload);
  });
  setHandler(
    stateQuery,
    () =>
      ({
        progress,
        steps,
        bufferedSignals,
      }) as unknown as { progress?: RunProgress; steps?: Record<string, StepRun> },
  );

  await eventActivity({
    name: 'orchestration.workflow.started',
    payload: {
      runId: args.runId,
      workflow: workflow.name,
      input: parsedInput,
      tenantId: args.tenantId,
    },
  });

  if (registration.hooks.onStart) {
    await hookActivity({
      workflowName: workflow.name,
      hook: 'onStart',
      payload: {
        runId: args.runId,
        input: parsedInput,
        tenantId: args.tenantId,
      },
      runId: args.runId,
    });
  }

  const results: Record<string, unknown> = {};
  try {
    for (const entry of workflow.steps) {
      if (entry._tag === 'Sleep') {
        const duration =
          typeof entry.duration === 'function'
            ? entry.duration({ workflowInput: parsedInput, results })
            : entry.duration;
        const wakeAt = new Date(Date.now() + duration);
        recordStepState(steps, entry.name, '__sleep__', {
          status: 'running',
          startedAt: new Date(),
        });
        await workflowSleep(duration);
        const output = { sleptMs: duration, wakeAt: wakeAt.toISOString() };
        results[entry.name] = output;
        recordStepState(steps, entry.name, '__sleep__', {
          status: 'completed',
          output,
          attempts: 1,
          completedAt: new Date(),
        });
        continue;
      }

      if (entry._tag === 'Parallel') {
        const stepContext = { workflowInput: parsedInput, results };
        const settled = await Promise.allSettled(
          entry.steps.map(async stepEntry => {
            const taskName = stepEntry.taskRef?.name ?? stepEntry.task;
            const taskManifest = registration.tasks[taskName];
            const merged = mergeTaskManifest(taskManifest, stepEntry.options);

            if (stepEntry.options.condition && !stepEntry.options.condition(stepContext)) {
              recordStepState(steps, stepEntry.name, taskName, {
                status: 'skipped',
                attempts: 0,
                completedAt: new Date(),
              });
              await eventActivity({
                name: 'orchestration.step.skipped',
                payload: {
                  runId: args.runId,
                  workflow: workflow.name,
                  step: stepEntry.name,
                },
              });
              return { stepName: stepEntry.name, skipped: true };
            }

            recordStepState(steps, stepEntry.name, taskName, {
              status: 'running',
              startedAt: new Date(),
            });

            const executeTask = createTaskActivity({
              queue: merged.queue,
              timeout: merged.timeout,
              retry: merged.retry,
            });
            const stepInput = stepEntry.options.input
              ? stepEntry.options.input(stepContext)
              : parsedInput;
            const childRunId = `${args.runId}:${stepEntry.name}`;
            const result = await executeTask({
              taskName,
              input: stepInput,
              runId: childRunId,
              tenantId: args.tenantId,
              parentWorkflowId: workflowInfo().workflowId,
              stepName: stepEntry.name,
            });
            return { stepName: stepEntry.name, taskName, result };
          }),
        );

        for (let index = 0; index < settled.length; index += 1) {
          const item = settled[index];
          const stepEntry = entry.steps[index];
          const taskName = stepEntry.taskRef?.name ?? stepEntry.task;
          if (item.status === 'fulfilled') {
            if ('skipped' in item.value) {
              results[stepEntry.name] = undefined;
              continue;
            }
            results[stepEntry.name] = item.value.result.output;
            recordStepState(steps, stepEntry.name, taskName, {
              status: 'completed',
              output: item.value.result.output,
              attempts: item.value.result.attempts,
              completedAt: new Date(),
            });
            await eventActivity({
              name: 'orchestration.step.completed',
              payload: {
                runId: args.runId,
                workflow: workflow.name,
                step: stepEntry.name,
                output: item.value.result.output,
              },
            });
            continue;
          }

          const error = toRunError(item.reason);
          recordStepState(steps, stepEntry.name, taskName, {
            status: 'failed',
            error,
            attempts: registration.tasks[taskName].retry.maxAttempts,
            completedAt: new Date(),
          });
          await eventActivity({
            name: 'orchestration.step.failed',
            payload: {
              runId: args.runId,
              workflow: workflow.name,
              step: stepEntry.name,
              error,
            },
          });
          if (!stepEntry.options.continueOnFailure && !failedStep) {
            failedStep = stepEntry.name;
            throw item.reason;
          }
        }
        continue;
      }

      const taskName = entry.taskRef?.name ?? entry.task;
      const taskManifest = registration.tasks[taskName];
      const merged = mergeTaskManifest(taskManifest, entry.options);
      const stepContext = { workflowInput: parsedInput, results };

      if (entry.options.condition && !entry.options.condition(stepContext)) {
        results[entry.name] = undefined;
        recordStepState(steps, entry.name, taskName, {
          status: 'skipped',
          attempts: 0,
          completedAt: new Date(),
        });
        await eventActivity({
          name: 'orchestration.step.skipped',
          payload: {
            runId: args.runId,
            workflow: workflow.name,
            step: entry.name,
          },
        });
        continue;
      }

      recordStepState(steps, entry.name, taskName, {
        status: 'running',
        startedAt: new Date(),
      });

      try {
        const executeTask = createTaskActivity({
          queue: merged.queue,
          timeout: merged.timeout,
          retry: merged.retry,
        });
        const result = await executeTask({
          taskName,
          input: entry.options.input ? entry.options.input(stepContext) : parsedInput,
          runId: `${args.runId}:${entry.name}`,
          tenantId: args.tenantId,
          parentWorkflowId: workflowInfo().workflowId,
          stepName: entry.name,
        });
        results[entry.name] = result.output;
        recordStepState(steps, entry.name, taskName, {
          status: 'completed',
          output: result.output,
          attempts: result.attempts,
          completedAt: new Date(),
        });
        await eventActivity({
          name: 'orchestration.step.completed',
          payload: {
            runId: args.runId,
            workflow: workflow.name,
            step: entry.name,
            output: result.output,
          },
        });
      } catch (error) {
        failedStep = entry.name;
        const runError = toRunError(error);
        recordStepState(steps, entry.name, taskName, {
          status: 'failed',
          error: runError,
          attempts: merged.retry.maxAttempts,
          completedAt: new Date(),
        });
        await eventActivity({
          name: 'orchestration.step.failed',
          payload: {
            runId: args.runId,
            workflow: workflow.name,
            step: entry.name,
            error: runError,
          },
        });
        if (entry.options.continueOnFailure) {
          results[entry.name] = undefined;
          continue;
        }
        throw error;
      }
    }

    const output = workflow.outputMapper ? workflow.outputMapper(results) : results;
    if (workflow.output) {
      workflow.output.parse(output);
    }

    if (registration.hooks.onComplete) {
      await hookActivity({
        workflowName: workflow.name,
        hook: 'onComplete',
        payload: {
          runId: args.runId,
          output,
          durationMs: Date.now() - runStartedAtMs,
          tenantId: args.tenantId,
        },
        runId: args.runId,
      });
    }

    await eventActivity({
      name: 'orchestration.workflow.completed',
      payload: {
        runId: args.runId,
        workflow: workflow.name,
        output,
        durationMs: Date.now() - runStartedAtMs,
        tenantId: args.tenantId,
      },
    });

    return {
      output,
      steps,
      progress,
    };
  } catch (error) {
    if (registration.hooks.onFail) {
      await hookActivity({
        workflowName: workflow.name,
        hook: 'onFail',
        payload: {
          runId: args.runId,
          error: error instanceof Error ? error : new Error(String(error)),
          failedStep,
          tenantId: args.tenantId,
        },
        runId: args.runId,
      });
    }

    await eventActivity({
      name: 'orchestration.workflow.failed',
      payload: {
        runId: args.runId,
        workflow: workflow.name,
        error: toRunError(error),
        failedStep,
        tenantId: args.tenantId,
      },
    });

    throw ApplicationFailure.nonRetryable('Slingshot workflow failed', 'SlingshotWorkflowFailure', {
      error: toRunError(error),
      failedStep,
      steps,
      progress,
    } satisfies TemporalFailureDetails);
  }
}
