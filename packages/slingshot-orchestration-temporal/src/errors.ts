import type { RunError } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration/errors';

export function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

export function wrapTemporalError(message: string, error: unknown): OrchestrationError {
  return new OrchestrationError(
    'ADAPTER_ERROR',
    error instanceof Error ? `${message}: ${error.message}` : `${message}: ${String(error)}`,
    error instanceof Error ? error : undefined,
  );
}
