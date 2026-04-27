import { describe, expect, test } from 'bun:test';
import { bullmqOrchestrationAdapterOptionsSchema } from '../src/validation';

describe('bullmqOrchestrationAdapterOptionsSchema', () => {
  test('accepts a minimal valid config with only connection', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379 },
    });
    expect(result.success).toBe(true);
  });

  test('accepts connection with extra fields (loose schema)', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379, tls: true, maxRetriesPerRequest: 3 },
    });
    expect(result.success).toBe(true);
  });

  test('accepts optional prefix and concurrency fields', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: {},
      prefix: 'my-app',
      concurrency: 10,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.prefix).toBe('my-app');
    expect(result.data.concurrency).toBe(10);
  });

  test('rejects a non-positive port number', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { port: -1 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects a non-integer port number', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: { port: 6379.5 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects a non-positive concurrency value', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: {},
      concurrency: 0,
    });
    expect(result.success).toBe(false);
  });

  test('rejects a non-integer concurrency value', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      connection: {},
      concurrency: 2.5,
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing connection field', () => {
    const result = bullmqOrchestrationAdapterOptionsSchema.safeParse({
      prefix: 'only-prefix',
    });
    expect(result.success).toBe(false);
  });
});
