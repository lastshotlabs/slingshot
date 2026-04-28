import type { Job } from 'bullmq';
import type {
  AnyResolvedTask,
  OrchestrationEventSink,
  RunError,
  TaskContext,
} from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';
import { readTaskRuntimeConfig, resolveTaskRuntimeConfig } from './taskRuntime';

function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

/**
 * Create the BullMQ task processor used by task workers and named task queues.
 */
export function createBullMQTaskProcessor(options: {
  taskRegistry: Map<string, AnyResolvedTask>;
  eventSink?: OrchestrationEventSink;
}) {
  return async function process(job: Job<Record<string, unknown>>) {
    if (job.name === '__slingshot_sleep') {
      return { sleptMs: job.data['durationMs'] };
    }

    const rawTaskName =
      typeof job.data['taskName'] === 'string' ? (job.data['taskName'] as string) : undefined;
    const runIdForLog =
      typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : String(job.id ?? '');

    if (rawTaskName === undefined || rawTaskName.length === 0) {
      const msg = `BullMQ job ${job.id} has invalid data: missing 'taskName' field`;
      // NOTE: never log job.data — payload may contain PII / secrets / large blobs.
      console.error(`[slingshot-orchestration-bullmq] ${msg}`, {
        runId: runIdForLog,
        taskName: rawTaskName,
        errorCode: 'TASK_DATA_MISSING_TASK_NAME',
      });
      throw new Error(msg);
    }

    if (!('input' in job.data)) {
      const msg = `BullMQ job ${job.id} has invalid data: missing 'input' field`;
      // NOTE: never log job.data — payload may contain PII / secrets / large blobs.
      console.error(`[slingshot-orchestration-bullmq] ${msg}`, {
        runId: runIdForLog,
        taskName: rawTaskName,
        errorCode: 'TASK_DATA_MISSING_INPUT',
      });
      throw new Error(msg);
    }

    const taskName = rawTaskName;
    const runId = String(job.data['runId'] ?? job.id ?? '');
    const def = options.taskRegistry.get(taskName);
    if (!def) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${taskName}' not registered`);
    }

    const taskRuntime = resolveTaskRuntimeConfig(def, readTaskRuntimeConfig(job.data));
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (taskRuntime.timeout !== undefined) {
      timeoutHandle = setTimeout(
        () => controller.abort(new Error('Task timed out')),
        taskRuntime.timeout,
      );
    }

    try {
      const validatedInput = def.input.parse(job.data['input']);
      const tenantId =
        typeof job.data['tenantId'] === 'string' ? (job.data['tenantId'] as string) : undefined;
      void options.eventSink?.emit('orchestration.task.started', {
        runId,
        task: taskName,
        input: validatedInput,
        tenantId,
      });
      const ctx: TaskContext = {
        attempt: job.attemptsMade + 1,
        runId,
        signal: controller.signal,
        log: console,
        tenantId,
        reportProgress: data => {
          job.updateProgress(data).catch((err: unknown) => {
            console.error('[slingshot-orchestration-bullmq] Failed to update job progress:', err);
          });
          void options.eventSink
            ?.emit('orchestration.task.progress', {
              runId,
              task: taskName,
              data,
            })
            ?.catch?.((err: unknown) => {
              console.error('[slingshot-orchestration-bullmq] Failed to emit progress event:', err);
            });
        },
      };
      const output = await def.handler(validatedInput, ctx);
      const parsedOutput = def.output.parse(output);
      void options.eventSink?.emit('orchestration.task.completed', {
        runId,
        task: taskName,
        output: parsedOutput,
        durationMs: job.processedOn ? Date.now() - job.processedOn : 0,
        tenantId,
      });
      return parsedOutput;
    } catch (error) {
      const runError = toRunError(error);
      void options.eventSink?.emit('orchestration.task.failed', {
        runId,
        task: taskName,
        error: runError,
        tenantId:
          typeof job.data['tenantId'] === 'string' ? (job.data['tenantId'] as string) : undefined,
      });
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
}
