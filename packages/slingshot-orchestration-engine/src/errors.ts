import type { OrchestrationErrorCode } from './types';

/**
 * Error type used by the orchestration runtime, adapters, and plugin helpers.
 *
 * Consumers should branch on `code` for durable error handling instead of parsing the
 * message text.
 */
export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  override readonly cause?: Error;

  constructor(code: OrchestrationErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Error raised when an orchestration operation exceeds its configured timeout.
 */
export class OrchestrationTimeoutError extends OrchestrationError {
  constructor(message: string, cause?: Error) {
    super('ORCHESTRATION_TIMEOUT', message, cause);
    this.name = 'OrchestrationTimeoutError';
  }
}

/**
 * Error raised when an underlying adapter (BullMQ, Temporal, etc.) encounters a failure
 * that is not covered by a more specific error type.
 */
export class OrchestrationAdapterError extends OrchestrationError {
  constructor(message: string, cause?: Error) {
    super('ADAPTER_ERROR', message, cause);
    this.name = 'OrchestrationAdapterError';
  }
}

/**
 * Error raised when a run lookup (by run id or filter) yields no result.
 */
export class OrchestrationRunNotFoundError extends OrchestrationError {
  constructor(message: string, cause?: Error) {
    super('RUN_NOT_FOUND', message, cause);
    this.name = 'OrchestrationRunNotFoundError';
  }
}
