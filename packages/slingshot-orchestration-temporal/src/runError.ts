import type { RunError } from '@lastshotlabs/slingshot-orchestration';

/**
 * Convert an unknown thrown value into the portable orchestration `RunError` shape.
 */
export function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
