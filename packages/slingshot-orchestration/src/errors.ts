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
