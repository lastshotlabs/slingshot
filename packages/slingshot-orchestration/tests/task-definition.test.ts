import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { assertKebab, defineTask, normalizeRetryPolicy } from '../src/defineTask';
import { OrchestrationError } from '../src/errors';

describe('assertKebab', () => {
  test('accepts valid kebab-case names', () => {
    expect(() => assertKebab('send-email', 'Task')).not.toThrow();
    expect(() => assertKebab('a', 'Task')).not.toThrow();
    expect(() => assertKebab('my-task-v2', 'Task')).not.toThrow();
    expect(() => assertKebab('abc123-def', 'Task')).not.toThrow();
  });

  test('rejects names starting with digit', () => {
    expect(() => assertKebab('1task', 'Task')).toThrow(OrchestrationError);
  });

  test('rejects names with uppercase', () => {
    expect(() => assertKebab('SendEmail', 'Task')).toThrow(OrchestrationError);
  });

  test('rejects names with underscores', () => {
    expect(() => assertKebab('send_email', 'Task')).toThrow(OrchestrationError);
  });

  test('rejects empty string', () => {
    expect(() => assertKebab('', 'Task')).toThrow(OrchestrationError);
  });

  test('error code is INVALID_CONFIG', () => {
    try {
      assertKebab('BadName', 'Task');
      expect.unreachable();
    } catch (e) {
      expect((e as OrchestrationError).code).toBe('INVALID_CONFIG');
    }
  });

  test('error message includes name and kind', () => {
    try {
      assertKebab('Bad', 'Workflow');
      expect.unreachable();
    } catch (e) {
      expect((e as OrchestrationError).message).toContain('Bad');
      expect((e as OrchestrationError).message).toContain('Workflow');
    }
  });
});

describe('normalizeRetryPolicy', () => {
  test('returns defaults for undefined retry', () => {
    const result = normalizeRetryPolicy(undefined, 'Test');
    expect(result.maxAttempts).toBe(1);
    expect(result.backoff).toBe('fixed');
    expect(result.delayMs).toBe(1000);
  });

  test('preserves explicit values', () => {
    const result = normalizeRetryPolicy(
      { maxAttempts: 3, delayMs: 500, backoff: 'exponential' },
      'Test',
    );
    expect(result.maxAttempts).toBe(3);
    expect(result.delayMs).toBe(500);
    expect(result.backoff).toBe('exponential');
  });

  test('sets maxDelayMs default for exponential backoff', () => {
    const result = normalizeRetryPolicy({ backoff: 'exponential' }, 'Test');
    expect(result.maxDelayMs).toBe(30000);
  });

  test('rejects maxDelayMs < delayMs', () => {
    expect(() => normalizeRetryPolicy({ maxDelayMs: 100, delayMs: 500 }, 'Test')).toThrow(
      OrchestrationError,
    );
  });

  test('rejects non-positive maxAttempts', () => {
    expect(() => normalizeRetryPolicy({ maxAttempts: 0 }, 'Test')).toThrow(OrchestrationError);
    expect(() => normalizeRetryPolicy({ maxAttempts: -1 }, 'Test')).toThrow(OrchestrationError);
  });

  test('rejects negative delayMs', () => {
    expect(() => normalizeRetryPolicy({ delayMs: -1 }, 'Test')).toThrow(OrchestrationError);
  });

  test('accepts delayMs of 0', () => {
    const result = normalizeRetryPolicy({ delayMs: 0 }, 'Test');
    expect(result.delayMs).toBe(0);
  });

  test('returned object is frozen', () => {
    const result = normalizeRetryPolicy({ maxAttempts: 2 }, 'Test');
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('defineTask', () => {
  const testSchema = z.object({ value: z.string() });

  test('creates a valid task', () => {
    const task = defineTask({
      name: 'my-task',
      input: testSchema,
      output: testSchema,
      handler: async () => ({ value: 'ok' }),
    });
    expect(task._tag).toBe('ResolvedTask');
    expect(task.name).toBe('my-task');
    expect(task.input).toBe(testSchema);
    expect(task.output).toBe(testSchema);
    expect(typeof task.handler).toBe('function');
    expect(Object.isFrozen(task)).toBe(true);
  });

  test('rejects task without input schema', () => {
    expect(() =>
      defineTask({
        name: 'bad-task',
        input: undefined as unknown as z.ZodType,
        output: testSchema,
        handler: async () => ({}),
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects task without output schema', () => {
    expect(() =>
      defineTask({
        name: 'bad-task',
        input: testSchema,
        output: undefined as unknown as z.ZodType,
        handler: async () => ({}),
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects task without handler', () => {
    expect(() =>
      defineTask({
        name: 'bad-task',
        input: testSchema,
        output: testSchema,
        handler: undefined as unknown as () => Promise<unknown>,
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects invalid concurrency', () => {
    expect(() =>
      defineTask({
        name: 'bad-task',
        input: testSchema,
        output: testSchema,
        handler: async () => ({}),
        concurrency: 0,
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects invalid timeout', () => {
    expect(() =>
      defineTask({
        name: 'bad-task',
        input: testSchema,
        output: testSchema,
        handler: async () => ({}),
        timeout: -5,
      }),
    ).toThrow(OrchestrationError);
  });

  test('accepts valid timeout and concurrency', () => {
    const task = defineTask({
      name: 'good-task',
      input: testSchema,
      output: testSchema,
      handler: async () => ({}),
      concurrency: 5,
      timeout: 30000,
    });
    expect(task.concurrency).toBe(5);
    expect(task.timeout).toBe(30000);
  });

  test('rejects non-kebab name', () => {
    expect(() =>
      defineTask({
        name: 'BadName',
        input: testSchema,
        output: testSchema,
        handler: async () => ({}),
      }),
    ).toThrow(OrchestrationError);
  });

  test('default retry values are set', () => {
    const task = defineTask({
      name: 'simple-task',
      input: testSchema,
      output: testSchema,
      handler: async () => ({}),
    });
    expect(task.retry.maxAttempts).toBe(1);
    expect(task.retry.backoff).toBe('fixed');
  });
});
