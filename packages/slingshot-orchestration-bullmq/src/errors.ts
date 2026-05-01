/** Errors thrown by the BullMQ orchestration adapter. */

import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';

export { classifyOrchestrationError, type ErrorClassification } from './errorClassification';
export { OrchestrationAdapterDisposedError } from './adapter';

/**
 * Base error for BullMQ-specific orchestration failures.
 *
 * Adds an `adapter` field so consumers can identify which adapter backend
 * produced the error when multiple orchestration adapters are in use.
 */
export class BullMQOrchestrationError extends OrchestrationError {
  readonly adapter: string = 'bullmq';

  constructor(message: string, cause?: Error) {
    super('ADAPTER_ERROR', `[bullmq] ${message}`, cause);
    this.name = 'BullMQOrchestrationError';
  }
}

/**
 * Error raised when the BullMQ adapter cannot establish or maintain a
 * connection to Redis.
 */
export class BullMQConnectionError extends BullMQOrchestrationError {
  constructor(message: string, cause?: Error) {
    super(`connection failed: ${message}`, cause);
    this.name = 'BullMQConnectionError';
  }
}
