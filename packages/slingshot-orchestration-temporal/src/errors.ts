import type { OrchestrationErrorCode } from '@lastshotlabs/slingshot-orchestration';
import {
  CancelledFailure,
  TerminatedFailure,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';

export { toRunError } from './runError';

/**
 * Base error for Temporal-specific orchestration failures.
 *
 * Adds an `adapter` field so consumers can identify which adapter backend
 * produced the error when multiple orchestration adapters are in use.
 */
export class TemporalOrchestrationError extends OrchestrationError {
  readonly adapter: string = 'temporal';

  constructor(code: OrchestrationErrorCode, message: string, cause?: Error) {
    super(code, `[temporal] ${message}`, cause);
    this.name = 'TemporalOrchestrationError';
  }
}

/**
 * Error raised when the Temporal adapter cannot establish or maintain a
 * connection to the Temporal server.
 */
export class TemporalConnectionError extends TemporalOrchestrationError {
  constructor(message: string, cause?: Error) {
    super('ADAPTER_ERROR', `connection failed: ${message}`, cause);
    this.name = 'TemporalConnectionError';
  }
}

/**
 * Map a Temporal failure to a typed {@link OrchestrationError} so that callers
 * receive a stable, machine-readable code rather than an opaque throw.
 *
 * Handled cases:
 * - `WorkflowFailedError` — surfaces the underlying cause message as `ADAPTER_ERROR`
 * - `CancelledFailure` — maps to `ADAPTER_ERROR` with a clear "cancelled" message
 * - `TerminatedFailure` — maps to `ADAPTER_ERROR` with a clear "terminated" message
 * - `TimeoutFailure` — maps to `ADAPTER_ERROR` with the timeout type in the message
 *
 * All other errors are wrapped with `wrapTemporalError`.
 */
export function mapTemporalFailure(prefix: string, error: unknown): OrchestrationError {
  if (error instanceof WorkflowFailedError) {
    const cause = error.cause;
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown cause';
    return new OrchestrationError(
      'ADAPTER_ERROR',
      `${prefix}: workflow failed — ${causeMessage}`,
      error,
    );
  }

  if (error instanceof CancelledFailure) {
    return new OrchestrationError('ADAPTER_ERROR', `${prefix}: run was cancelled`, error);
  }

  if (error instanceof TerminatedFailure) {
    return new OrchestrationError('ADAPTER_ERROR', `${prefix}: run was terminated`, error);
  }

  if (error instanceof TimeoutFailure) {
    return new OrchestrationError(
      'ADAPTER_ERROR',
      `${prefix}: run timed out (${error.timeoutType})`,
      error,
    );
  }

  return wrapTemporalError(prefix, error);
}

/**
 * Wrap an unknown Temporal failure in a portable {@link OrchestrationError}.
 */
export function wrapTemporalError(message: string, error: unknown): OrchestrationError {
  return new OrchestrationError(
    'ADAPTER_ERROR',
    error instanceof Error ? `${message}: ${error.message}` : `${message}: ${String(error)}`,
    error instanceof Error ? error : undefined,
  );
}
