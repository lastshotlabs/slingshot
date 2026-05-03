import type { Job, Queue, QueueEvents } from 'bullmq';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';
import { OrchestrationError, generateRunId } from '@lastshotlabs/slingshot-orchestration';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationEventSink,
  RunError,
  StepEntry,
} from '@lastshotlabs/slingshot-orchestration';
import { createJobRetryOptions, resolveTaskRuntimeConfig } from './taskRuntime';

function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function reportWorkflowHookError(options: {
  eventSink?: OrchestrationEventSink;
  logger: Logger;
  runId: string;
  workflow: string;
  hook: 'onStart' | 'onComplete' | 'onFail';
  error: unknown;
}): void {
  options.logger.error(`Workflow ${options.hook} hook failed`, {
    runId: options.runId,
    workflow: options.workflow,
    hook: options.hook,
    err: toRunError(options.error),
  });
  if (options.eventSink) {
    void options.eventSink.emit('orchestration.workflow.hookError', {
      runId: options.runId,
      workflow: options.workflow,
      hook: options.hook,
      error: toRunError(options.error),
    });
  }
}

type WorkflowHookHandler<TPayload> = (payload: TPayload) => Promise<void> | void;

type WorkflowHookConfig<TPayload> =
  | WorkflowHookHandler<TPayload>
  | {
      handler: WorkflowHookHandler<TPayload>;
      continueOnHookError?: boolean;
    };

function normalizeWorkflowHook<TPayload>(
  hook: WorkflowHookConfig<TPayload> | undefined,
): { handler: WorkflowHookHandler<TPayload>; continueOnHookError: boolean } | undefined {
  if (hook === undefined) {
    return undefined;
  }
  if (typeof hook === 'function') {
    return { handler: hook, continueOnHookError: false };
  }
  return { handler: hook.handler, continueOnHookError: hook.continueOnHookError ?? false };
}

function assertSleepDuration(stepName: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Sleep step '${stepName}' duration must be a non-negative finite number.`,
    );
  }
}

/**
 * Create the BullMQ workflow processor that walks workflow steps and dispatches child
 * task jobs onto the appropriate BullMQ queues.
 */
export function createBullMQWorkflowProcessor(options: {
  workflowRegistry: Map<string, AnyResolvedWorkflow>;
  taskRegistry: Map<string, AnyResolvedTask>;
  getTaskQueue(taskName: string): Queue;
  getTaskQueueEvents(taskName: string): QueueEvents;
  eventSink?: OrchestrationEventSink;
  logger?: Logger;
  /**
   * Optional `HookServices` for workflow `onStart`/`onComplete`/`onFail` hooks.
   * Provided by the bullmq adapter when the worker process is also the main app
   * process (services accessible). When the worker runs in a separate process
   * (no app reference), services is `undefined`.
   */
  hookServices?: import('@lastshotlabs/slingshot-core').HookServices;
}) {
  const logger =
    options.logger ?? createConsoleLogger({ base: { component: 'slingshot-bullmq' } });
  function resolveTask(step: StepEntry): AnyResolvedTask {
    if (step.taskRef) return step.taskRef;
    const task = options.taskRegistry.get(step.task);
    if (!task) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${step.task}' not registered`);
    }
    return task;
  }

  return async function process(job: Job<Record<string, unknown>>) {
    const rawWorkflowName =
      typeof job.data['workflowName'] === 'string'
        ? (job.data['workflowName'] as string)
        : undefined;
    const runIdForLog =
      typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : String(job.id ?? '');

    if (rawWorkflowName === undefined || rawWorkflowName.length === 0) {
      const msg = `BullMQ job ${job.id} has invalid data: missing 'workflowName' field`;
      // NOTE: never log job.data — payload may contain PII / secrets / large blobs.
      logger.error('Workflow job missing workflowName', {
        runId: runIdForLog,
        errorCode: 'WORKFLOW_DATA_MISSING_WORKFLOW_NAME',
      });
      throw new Error(msg);
    }

    const workflowName = rawWorkflowName;
    const runId = String(job.data['runId'] ?? job.id ?? '');
    const def = options.workflowRegistry.get(workflowName);
    if (!def) {
      throw new OrchestrationError(
        'WORKFLOW_NOT_FOUND',
        `Workflow '${workflowName}' not registered`,
      );
    }

    const workflowInput = def.input.parse(job.data['input']);
    const results: Record<string, unknown> = {};
    const childJobIds: string[] = [];
    const startedAt = Date.now();
    let failedStep: string | undefined;
    const tenantId =
      typeof job.data['tenantId'] === 'string' ? (job.data['tenantId'] as string) : undefined;

    void options.eventSink?.emit('orchestration.workflow.started', {
      runId,
      workflow: workflowName,
      input: workflowInput,
      tenantId,
    });

    const onStart = normalizeWorkflowHook(def.onStart);
    if (onStart) {
      try {
        await onStart.handler({
          runId,
          input: workflowInput,
          tenantId,
          services: options.hookServices,
        });
      } catch (error) {
        reportWorkflowHookError({
          eventSink: options.eventSink,
          logger,
          runId,
          workflow: workflowName,
          hook: 'onStart',
          error,
        });
      }
    }

    try {
      for (const entry of def.steps) {
        if (entry._tag === 'Sleep') {
          const stepContext = { workflowInput, results };
          const durationMs =
            typeof entry.duration === 'function' ? entry.duration(stepContext) : entry.duration;
          assertSleepDuration(entry.name, durationMs);
          const sleepJobId = `${runId}:sleep:${entry.name}`;
          const taskQueue = options.getTaskQueue('__slingshot_sleep');
          const queueEvents = options.getTaskQueueEvents('__slingshot_sleep');
          const sleepJob = await taskQueue.add(
            '__slingshot_sleep',
            {
              runId,
              durationMs,
            },
            {
              jobId: sleepJobId,
              delay: durationMs,
            },
          );
          childJobIds.push(String(sleepJob.id));
          await job.updateData({ ...job.data, _childJobIds: childJobIds });
          results[entry.name] = await sleepJob.waitUntilFinished(queueEvents);
          continue;
        }

        if (entry._tag === 'Parallel') {
          const context = { workflowInput, results };
          const activeSteps = entry.steps.filter(
            step => !step.options.condition || step.options.condition(context),
          );
          for (const step of entry.steps) {
            if (step.options.condition && !step.options.condition(context)) {
              results[step.name] = undefined;
              void options.eventSink?.emit('orchestration.step.skipped', {
                runId,
                workflow: workflowName,
                step: step.name,
              });
            }
          }

          const jobs = await Promise.all(
            activeSteps.map(async step => {
              const task = resolveTask(step);
              const taskRuntime = resolveTaskRuntimeConfig(task, {
                retry: step.options.retry ?? task.retry,
                timeout: step.options.timeout,
              });
              const taskQueue = options.getTaskQueue(task.name);
              const taskJob = await taskQueue.add(
                task.name,
                {
                  taskName: task.name,
                  input: step.options.input ? step.options.input(context) : workflowInput,
                  runId: generateRunId(),
                  tenantId: job.data['tenantId'],
                  tags: job.data['tags'],
                  metadata: job.data['metadata'],
                  taskRuntime,
                },
                {
                  delay: 0,
                  priority: typeof job.opts.priority === 'number' ? job.opts.priority : undefined,
                  ...createJobRetryOptions(taskRuntime),
                  ...(job.data['adapterHints'] && typeof job.data['adapterHints'] === 'object'
                    ? (job.data['adapterHints'] as Record<string, unknown>)
                    : {}),
                },
              );
              childJobIds.push(String(taskJob.id));
              return { step, task, taskJob };
            }),
          );
          await job.updateData({ ...job.data, _childJobIds: childJobIds });

          const settled = await Promise.allSettled(
            jobs.map(async item =>
              item.taskJob.waitUntilFinished(options.getTaskQueueEvents(item.task.name)),
            ),
          );

          let hardFailure: unknown = null;
          for (let index = 0; index < jobs.length; index += 1) {
            const item = jobs[index];
            const result = settled[index];
            if (result.status === 'fulfilled') {
              results[item.step.name] = result.value;
              void options.eventSink?.emit('orchestration.step.completed', {
                runId,
                workflow: workflowName,
                step: item.step.name,
                output: result.value,
              });
            } else {
              const error = toRunError(result.reason);
              results[item.step.name] = undefined;
              void options.eventSink?.emit('orchestration.step.failed', {
                runId,
                workflow: workflowName,
                step: item.step.name,
                error,
              });
              if (!item.step.options.continueOnFailure && hardFailure === null) {
                hardFailure = result.reason;
                failedStep = item.step.name;
              }
            }
          }
          if (hardFailure !== null) throw hardFailure;
          continue;
        }

        const task = resolveTask(entry);
        const taskRuntime = resolveTaskRuntimeConfig(task, {
          retry: entry.options.retry ?? task.retry,
          timeout: entry.options.timeout,
        });
        const context = { workflowInput, results };
        if (entry.options.condition && !entry.options.condition(context)) {
          results[entry.name] = undefined;
          void options.eventSink?.emit('orchestration.step.skipped', {
            runId,
            workflow: workflowName,
            step: entry.name,
          });
          continue;
        }

        const taskQueue = options.getTaskQueue(task.name);
        const taskJob = await taskQueue.add(
          task.name,
          {
            taskName: task.name,
            input: entry.options.input ? entry.options.input(context) : workflowInput,
            runId: generateRunId(),
            tenantId: job.data['tenantId'],
            tags: job.data['tags'],
            metadata: job.data['metadata'],
            taskRuntime,
          },
          {
            delay: 0,
            priority: typeof job.opts.priority === 'number' ? job.opts.priority : undefined,
            ...createJobRetryOptions(taskRuntime),
            ...(job.data['adapterHints'] && typeof job.data['adapterHints'] === 'object'
              ? (job.data['adapterHints'] as Record<string, unknown>)
              : {}),
          },
        );
        childJobIds.push(String(taskJob.id));
        await job.updateData({ ...job.data, _childJobIds: childJobIds });

        try {
          const output = await taskJob.waitUntilFinished(options.getTaskQueueEvents(task.name));
          results[entry.name] = output;
          void options.eventSink?.emit('orchestration.step.completed', {
            runId,
            workflow: workflowName,
            step: entry.name,
            output,
          });
        } catch (error) {
          const runError = toRunError(error);
          void options.eventSink?.emit('orchestration.step.failed', {
            runId,
            workflow: workflowName,
            step: entry.name,
            error: runError,
          });
          if (entry.options.continueOnFailure) {
            results[entry.name] = undefined;
            continue;
          }
          failedStep = entry.name;
          throw error;
        }
      }

      const output = def.outputMapper ? def.outputMapper(results) : results;
      if (def.output) {
        def.output.parse(output);
      }
      void options.eventSink?.emit('orchestration.workflow.completed', {
        runId,
        workflow: workflowName,
        output,
        durationMs: Date.now() - startedAt,
        tenantId,
      });
      const onComplete = normalizeWorkflowHook(def.onComplete);
      if (onComplete) {
        try {
          await onComplete.handler({
            runId,
            output,
            durationMs: Date.now() - startedAt,
            tenantId,
            services: options.hookServices,
          });
        } catch (hookError) {
          reportWorkflowHookError({
            eventSink: options.eventSink,
            logger,
            runId,
            workflow: workflowName,
            hook: 'onComplete',
            error: hookError,
          });
        }
      }
      return output;
    } catch (error) {
      const runError = toRunError(error);
      void options.eventSink?.emit('orchestration.workflow.failed', {
        runId,
        workflow: workflowName,
        error: runError,
        failedStep,
        tenantId,
      });
      const onFail = normalizeWorkflowHook(def.onFail);
      if (onFail) {
        try {
          await onFail.handler({
            runId,
            error: error instanceof Error ? error : new Error(String(error)),
            failedStep,
            tenantId,
            services: options.hookServices,
          });
        } catch (hookError) {
          reportWorkflowHookError({
            eventSink: options.eventSink,
            logger,
            runId,
            workflow: workflowName,
            hook: 'onFail',
            error: hookError,
          });
        }
      }
      throw error;
    }
  };
}
