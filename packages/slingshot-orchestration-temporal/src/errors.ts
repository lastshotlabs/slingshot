import {
  CancelledFailure,
  TerminatedFailure,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import type { RunError } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';

export function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
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

export function wrapTemporalError(message: string, error: unknown): OrchestrationError {
  return new OrchestrationError(
    'ADAPTER_ERROR',
    error instanceof Error ? `${message}: ${error.message}` : `${message}: ${String(error)}`,
    error instanceof Error ? error : undefined,
  );
}
