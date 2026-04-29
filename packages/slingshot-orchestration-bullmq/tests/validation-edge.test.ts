import { describe, expect, test } from 'bun:test';
import { bullmqOrchestrationAdapterOptionsSchema } from '../src/validation';

describe('bullmqOrchestrationAdapterOptionsSchema', () => {
  test('accepts minimal valid config', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing connection', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects port as string', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { port: '6379' },
    });
    expect(result.success).toBe(false);
  });

  test('accepts TLS config', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379, tls: {} },
    });
    expect(result.success).toBe(true);
  });

  test('accepts job retention settings', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
    });
    expect(result.success).toBe(true);
  });

  test('accepts worker concurrency', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
      worker: { concurrency: 10 },
    });
    expect(result.success).toBe(true);
  });

  test('accepts task queue prefix', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
      taskQueuePrefix: 'my-tasks',
    });
    expect(result.success).toBe(true);
  });
});
