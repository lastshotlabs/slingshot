import type { BackoffStrategy, JobsOptions } from 'bullmq';
import type { AnyResolvedTask, RetryPolicy } from '@lastshotlabs/slingshot-orchestration';

export interface TaskRuntimeConfig {
  retry: RetryPolicy;
  timeout?: number;
}

export interface TaskJobData {
  taskRuntime?: TaskRuntimeConfig;
}

function isRetryPolicy(value: unknown): value is RetryPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy['maxAttempts'] === 'number' &&
    (policy['backoff'] === undefined ||
      policy['backoff'] === 'fixed' ||
      policy['backoff'] === 'exponential') &&
    (policy['delayMs'] === undefined || typeof policy['delayMs'] === 'number') &&
    (policy['maxDelayMs'] === undefined || typeof policy['maxDelayMs'] === 'number')
  );
}

export function readTaskRuntimeConfig(
  data: Record<string, unknown>,
): TaskRuntimeConfig | undefined {
  const value = data['taskRuntime'];
  if (!value || typeof value !== 'object') return undefined;

  const taskRuntime = value as Record<string, unknown>;
  if (!isRetryPolicy(taskRuntime['retry'])) {
    return undefined;
  }

  return {
    retry: taskRuntime['retry'],
    timeout:
      typeof taskRuntime['timeout'] === 'number' ? (taskRuntime['timeout'] as number) : undefined,
  };
}

export function resolveTaskRuntimeConfig(
  task: AnyResolvedTask,
  override?: TaskRuntimeConfig,
): TaskRuntimeConfig {
  return {
    retry: {
      maxAttempts: override?.retry.maxAttempts ?? task.retry.maxAttempts,
      backoff: override?.retry.backoff ?? task.retry.backoff,
      delayMs: override?.retry.delayMs ?? task.retry.delayMs,
      maxDelayMs: override?.retry.maxDelayMs ?? task.retry.maxDelayMs,
    },
    timeout: override?.timeout ?? task.timeout,
  };
}

export function computeRetryDelay(retry: RetryPolicy, attempt: number): number {
  const baseDelay = retry.delayMs ?? 1_000;
  if (retry.backoff === 'exponential') {
    const computed = baseDelay * 2 ** Math.max(0, attempt - 1);
    return Math.min(computed, retry.maxDelayMs ?? computed);
  }
  return baseDelay;
}

export function createJobRetryOptions(
  taskRuntime: TaskRuntimeConfig,
): Pick<JobsOptions, 'attempts' | 'backoff'> {
  return {
    attempts: taskRuntime.retry.maxAttempts,
    backoff:
      taskRuntime.retry.maxAttempts > 1
        ? {
            type: 'slingshot',
            delay: taskRuntime.retry.delayMs ?? 1_000,
          }
        : undefined,
  };
}

export const bullmqBackoffStrategy: BackoffStrategy = (_attemptsMade, _type, _err, job) => {
  const data =
    job && typeof job === 'object' && 'data' in job && job.data && typeof job.data === 'object'
      ? (job.data as Record<string, unknown>)
      : undefined;
  const taskRuntime = data ? readTaskRuntimeConfig(data) : undefined;
  if (!taskRuntime) return 0;
  return computeRetryDelay(taskRuntime.retry, job?.attemptsMade ?? 1);
};
