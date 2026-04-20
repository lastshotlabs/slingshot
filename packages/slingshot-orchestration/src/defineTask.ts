import type { RetryPolicy, TaskDefinition, ResolvedTask } from './types';
import { OrchestrationError } from './errors';

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validate that a public orchestration identifier uses kebab-case.
 */
export function assertKebab(name: string, kind: string): void {
  if (!KEBAB_RE.test(name)) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `${kind} name '${name}' must be kebab-case (lowercase, hyphens only, no leading digits).`,
    );
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OrchestrationError('INVALID_CONFIG', message);
  }
}

function assertPositiveFiniteNumber(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new OrchestrationError('INVALID_CONFIG', message);
  }
}

function assertNonNegativeInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new OrchestrationError('INVALID_CONFIG', message);
  }
}

export function normalizeRetryPolicy(
  retry: RetryPolicy | undefined,
  ownerLabel: string,
): RetryPolicy {
  if (retry?.maxAttempts !== undefined) {
    assertPositiveInteger(
      retry.maxAttempts,
      `${ownerLabel} retry maxAttempts must be a positive integer.`,
    );
  }
  if (retry?.delayMs !== undefined) {
    assertNonNegativeInteger(
      retry.delayMs,
      `${ownerLabel} retry delayMs must be a non-negative integer.`,
    );
  }
  if (retry?.maxDelayMs !== undefined) {
    assertPositiveInteger(
      retry.maxDelayMs,
      `${ownerLabel} retry maxDelayMs must be a positive integer.`,
    );
  }
  if (retry?.maxDelayMs !== undefined && retry?.delayMs !== undefined && retry.maxDelayMs < retry.delayMs) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `${ownerLabel} retry maxDelayMs must be >= delayMs.`,
    );
  }

  return Object.freeze({
    maxAttempts: retry?.maxAttempts ?? 1,
    backoff: retry?.backoff ?? 'fixed',
    delayMs: retry?.delayMs ?? 1_000,
    maxDelayMs: retry?.maxDelayMs,
  });
}

/**
 * Define a retryable task that can be registered with an orchestration runtime.
 *
 * The returned object is frozen and carries normalized retry settings so downstream
 * adapters and workflow steps do not need to repeat defaulting logic.
 */
export function defineTask<TInput, TOutput>(
  config: TaskDefinition<TInput, TOutput>,
): ResolvedTask<TInput, TOutput> {
  assertKebab(config.name, 'Task');
  if (!config.input || !config.output) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Task '${config.name}' requires input and output schemas.`,
    );
  }
  if (typeof config.handler !== 'function') {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Task '${config.name}' requires an async handler function.`,
    );
  }
  if (config.concurrency !== undefined) {
    assertPositiveInteger(
      config.concurrency,
      `Task '${config.name}' concurrency must be a positive integer.`,
    );
  }
  if (config.timeout !== undefined) {
    assertPositiveFiniteNumber(
      config.timeout,
      `Task '${config.name}' timeout must be a positive number.`,
    );
  }

  return Object.freeze({
    _tag: 'ResolvedTask' as const,
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    handler: config.handler,
    retry: normalizeRetryPolicy(config.retry, `Task '${config.name}'`),
    timeout: config.timeout,
    queue: config.queue,
    concurrency: config.concurrency,
  });
}
