import { Context } from '@temporalio/activity';
import { Client } from '@temporalio/client';
import type { ClientInterceptors, ConnectionLike } from '@temporalio/client';
import type { DataConverter } from '@temporalio/common';
import type {
  OrchestrationEventMap,
  OrchestrationEventSink,
  TaskContext,
} from '@lastshotlabs/slingshot-orchestration';
import { withTaskConcurrency } from './concurrency';
import { toRunError } from './errors';
import { getRegisteredTask, getRegisteredWorkflowHooks } from './workerRegistry';

export interface ExecuteSlingshotTaskArgs {
  taskName: string;
  input: unknown;
  runId: string;
  tenantId?: string;
  parentWorkflowId: string;
  stepName?: string;
}

export interface ExecuteSlingshotTaskResult {
  output: unknown;
  attempts: number;
}

export interface ExecuteWorkflowHookArgs {
  workflowName: string;
  hook: 'onStart' | 'onComplete' | 'onFail';
  payload: unknown;
  runId: string;
}

export interface EmitOrchestrationEventArgs {
  name: keyof OrchestrationEventMap;
  payload: OrchestrationEventMap[keyof OrchestrationEventMap];
}

export function createTemporalActivities(options: {
  connection: ConnectionLike;
  namespace?: string;
  eventSink?: OrchestrationEventSink;
  /**
   * Optional Temporal `DataConverter` forwarded to the internal `Client`.
   * Required for codec symmetry: without it, signals emitted from activities
   * (e.g. `slingshot-progress`) bypass the payload codec installed on the
   * server-side `Client` and `Worker`, leaking unredacted PII to Temporal
   * Web UI and the visibility store. Should match the converter used on the
   * worker and the server-side `Client`.
   */
  dataConverter?: DataConverter;
  /**
   * Optional Temporal client interceptors forwarded to the internal `Client`.
   * Mirrors the interceptors installed on the server-side `Client` so that
   * cross-cutting concerns (auth headers, tracing, redaction) stay symmetric
   * for activity-emitted child workflow signals.
   */
  interceptors?: ClientInterceptors;
}) {
  const client = new Client({
    connection: options.connection,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.dataConverter ? { dataConverter: options.dataConverter } : {}),
    ...(options.interceptors ? { interceptors: options.interceptors } : {}),
  });

  return {
    async executeSlingshotTask(
      args: ExecuteSlingshotTaskArgs,
    ): Promise<ExecuteSlingshotTaskResult> {
      const task = getRegisteredTask(args.taskName);
      if (!task) {
        throw new Error(`Task '${args.taskName}' is not registered in the Temporal worker.`);
      }

      const activityContext = Context.current();
      const handle = client.workflow.getHandle(args.parentWorkflowId);
      const parsedInput = task.input.parse(args.input);

      await options.eventSink?.emit('orchestration.task.started', {
        runId: args.runId,
        task: task.name,
        input: parsedInput,
        tenantId: args.tenantId,
      });

      const taskContext: TaskContext = {
        attempt: activityContext.info.attempt,
        runId: args.runId,
        signal: activityContext.cancellationSignal,
        log: console,
        tenantId: args.tenantId,
        reportProgress(data) {
          void handle.signal('slingshot-progress', {
            stepName: args.stepName,
            data,
          });
          void options.eventSink?.emit('orchestration.task.progress', {
            runId: args.runId,
            task: task.name,
            data,
          });
        },
      };

      try {
        const output = await withTaskConcurrency(task.name, task.concurrency, async () =>
          task.output.parse(await task.handler(parsedInput, taskContext)),
        );

        await options.eventSink?.emit('orchestration.task.completed', {
          runId: args.runId,
          task: task.name,
          output,
          durationMs: Date.now() - activityContext.info.currentAttemptScheduledTimestampMs,
          tenantId: args.tenantId,
        });

        return {
          output,
          attempts: activityContext.info.attempt,
        };
      } catch (error) {
        await options.eventSink?.emit('orchestration.task.failed', {
          runId: args.runId,
          task: task.name,
          error: toRunError(error),
          tenantId: args.tenantId,
        });
        throw error;
      }
    },

    async executeWorkflowHook(args: ExecuteWorkflowHookArgs): Promise<void> {
      const hooks = getRegisteredWorkflowHooks(args.workflowName);
      const hook = hooks?.[args.hook];
      if (!hook) {
        return;
      }

      try {
        await hook(args.payload as never);
      } catch (error) {
        // Log and emit the error, then rethrow so Temporal can retry the activity.
        // Swallowing hook errors would allow a workflow to appear successful even
        // when its completion hook failed — better to be loud and retryable.
        console.error('[slingshot-orchestration-temporal] workflow hook failed', error);
        await options.eventSink?.emit('orchestration.workflow.hookError', {
          runId: args.runId,
          workflow: args.workflowName,
          hook: args.hook,
          error: toRunError(error),
        });
        throw error;
      }
    },

    async emitOrchestrationEvent(args: EmitOrchestrationEventArgs): Promise<void> {
      await options.eventSink?.emit(args.name, args.payload);
    },
  };
}
