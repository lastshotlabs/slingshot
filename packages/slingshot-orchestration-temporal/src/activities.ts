import { Context } from '@temporalio/activity';
import { Client } from '@temporalio/client';
import type { ConnectionLike } from '@temporalio/client';
import type {
  OrchestrationEventMap,
  OrchestrationEventSink,
  Run,
  TaskContext,
} from '@lastshotlabs/slingshot-orchestration';
import { toRunError } from './errors';
import { getRegisteredTask, getRegisteredWorkflowHooks } from './workerRegistry';
import { withTaskConcurrency } from './concurrency';

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
}) {
  const client = new Client({
    connection: options.connection,
    ...(options.namespace ? { namespace: options.namespace } : {}),
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
        console.error('[slingshot-orchestration-temporal] workflow hook failed', error);
        await options.eventSink?.emit('orchestration.workflow.hookError', {
          runId: args.runId,
          workflow: args.workflowName,
          hook: args.hook,
          error: toRunError(error),
        });
      }
    },

    async emitOrchestrationEvent(args: EmitOrchestrationEventArgs): Promise<void> {
      await options.eventSink?.emit(args.name, args.payload);
    },
  };
}
