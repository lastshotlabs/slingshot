import { describe, expect, test } from 'bun:test';
import { OrchestrationError } from '../src/errors';

describe('OrchestrationError', () => {
  test('sets name, code, and message', () => {
    const err = new OrchestrationError('INVALID_CONFIG', 'test message');
    expect(err.name).toBe('OrchestrationError');
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe('test message');
  });

  test('is instance of Error', () => {
    const err = new OrchestrationError('TASK_NOT_FOUND', 'task missing');
    expect(err).toBeInstanceOf(Error);
  });

  test('supports cause chaining', () => {
    const cause = new Error('root');
    const err = new OrchestrationError('ADAPTER_ERROR', 'wrap', cause);
    expect(err.cause).toBe(cause);
  });

  test('cause is undefined when not provided', () => {
    const err = new OrchestrationError('RUN_NOT_FOUND', 'nope');
    expect(err.cause).toBeUndefined();
  });

  test('all error codes are usable', () => {
    const codes = [
      'INVALID_CONFIG',
      'TASK_NOT_FOUND',
      'WORKFLOW_NOT_FOUND',
      'RUN_NOT_FOUND',
      'ADAPTER_ERROR',
      'RUN_CANCELLED',
      'IDEMPOTENCY_CONFLICT',
      'WORKFLOW_HOOK_ERROR',
    ] as const;
    for (const code of codes) {
      const err = new OrchestrationError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });

  test('message is accessible via toString', () => {
    const err = new OrchestrationError('INVALID_CONFIG', 'config is broken');
    expect(err.toString()).toContain('config is broken');
  });
});
