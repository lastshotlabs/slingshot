import { describe, expect, test } from 'bun:test';
import {
  runOptionsSchema,
  retryPolicySchema,
  memoryAdapterOptionsSchema,
  sqliteAdapterOptionsSchema,
} from '../src/validation';

describe('retryPolicySchema', () => {
  test('accepts valid retry policy', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 3, backoff: 'exponential', delayMs: 1000 }).success).toBe(true);
  });

  test('accepts minimal retry policy', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 1 }).success).toBe(true);
  });

  test('rejects non-positive maxAttempts', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
  });

  test('rejects negative delayMs', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 3, delayMs: -1 }).success).toBe(false);
  });

  test('rejects maxDelayMs < delayMs', () => {
    const result = retryPolicySchema.safeParse({ maxAttempts: 3, delayMs: 1000, maxDelayMs: 500 });
    expect(result.success).toBe(false);
  });

  test('accepts maxDelayMs >= delayMs', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 3, delayMs: 1000, maxDelayMs: 2000 }).success).toBe(true);
  });

  test('accepts equal maxDelayMs and delayMs', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 3, delayMs: 1000, maxDelayMs: 1000 }).success).toBe(true);
  });

  test('rejects invalid backoff strategy', () => {
    expect(retryPolicySchema.safeParse({ maxAttempts: 3, backoff: 'linear' }).success).toBe(false);
  });
});

describe('runOptionsSchema', () => {
  test('accepts empty options', () => {
    expect(runOptionsSchema.safeParse({}).success).toBe(true);
  });

  test('accepts valid run options', () => {
    const result = runOptionsSchema.safeParse({
      idempotencyKey: 'key-1',
      delay: 5000,
      tenantId: 'tenant-1',
      priority: 10,
      tags: { env: 'prod', region: 'us-east' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects empty idempotencyKey', () => {
    expect(runOptionsSchema.safeParse({ idempotencyKey: '' }).success).toBe(false);
  });

  test('rejects negative delay', () => {
    expect(runOptionsSchema.safeParse({ delay: -1 }).success).toBe(false);
  });

  test('accepts zero delay', () => {
    expect(runOptionsSchema.safeParse({ delay: 0 }).success).toBe(true);
  });

  test('accepts max priority', () => {
    expect(runOptionsSchema.safeParse({ priority: 1_000_000 }).success).toBe(true);
  });

  test('accepts min priority', () => {
    expect(runOptionsSchema.safeParse({ priority: -1_000_000 }).success).toBe(true);
  });

  test('rejects priority below min', () => {
    expect(runOptionsSchema.safeParse({ priority: -1_000_001 }).success).toBe(false);
  });

  test('rejects priority above max', () => {
    expect(runOptionsSchema.safeParse({ priority: 1_000_001 }).success).toBe(false);
  });

  test('rejects more than 50 tags', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 51; i++) tags[`key${i}`] = `value${i}`;
    expect(runOptionsSchema.safeParse({ tags }).success).toBe(false);
  });

  test('accepts exactly 50 tags', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 50; i++) tags[`key${i}`] = `value${i}`;
    expect(runOptionsSchema.safeParse({ tags }).success).toBe(true);
  });

  test('accepts metadata with arbitrary values', () => {
    expect(runOptionsSchema.safeParse({ metadata: { custom: true, count: 5, nested: { a: 1 } } }).success).toBe(true);
  });

  test('accepts adapter hints', () => {
    expect(runOptionsSchema.safeParse({ adapterHints: { queue: 'critical' } }).success).toBe(true);
  });
});

describe('memoryAdapterOptionsSchema', () => {
  test('accepts empty options', () => {
    expect(memoryAdapterOptionsSchema.safeParse({}).success).toBe(true);
  });

  test('accepts valid options', () => {
    expect(memoryAdapterOptionsSchema.safeParse({ concurrency: 5, maxPayloadBytes: 2048 }).success).toBe(true);
  });

  test('rejects zero concurrency', () => {
    expect(memoryAdapterOptionsSchema.safeParse({ concurrency: 0 }).success).toBe(false);
  });

  test('rejects non-positive maxPayloadBytes', () => {
    expect(memoryAdapterOptionsSchema.safeParse({ maxPayloadBytes: 0 }).success).toBe(false);
  });
});

describe('sqliteAdapterOptionsSchema', () => {
  test('requires path', () => {
    expect(sqliteAdapterOptionsSchema.safeParse({}).success).toBe(false);
    expect(sqliteAdapterOptionsSchema.safeParse({ path: '' }).success).toBe(false);
  });

  test('accepts :memory: path', () => {
    expect(sqliteAdapterOptionsSchema.safeParse({ path: ':memory:' }).success).toBe(true);
  });

  test('accepts file path', () => {
    expect(sqliteAdapterOptionsSchema.safeParse({ path: '/tmp/orch.db' }).success).toBe(true);
  });

  test('accepts full options', () => {
    expect(
      sqliteAdapterOptionsSchema.safeParse({
        path: '/tmp/orch.db',
        concurrency: 10,
        maxPayloadBytes: 5242880,
      }).success,
    ).toBe(true);
  });
});
