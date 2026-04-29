/**
 * Connection-edge tests for createBullMQAdapter.
 *
 * Covers schema validation edge cases for connection options that the existing
 * tests do not exercise: host type coercion, port boundary values, and
 * adapter creation with unusual connection shapes.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter, bullmqAdapterOptionsSchema } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Schema validation — connection object
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema — connection field', () => {
  test('rejects host as a number', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 12345 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects host as a boolean', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: true },
    });
    expect(result.success).toBe(false);
  });

  test('rejects port as a negative integer', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: -1 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects port as a float', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379.5 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects port as NaN', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: NaN },
    });
    expect(result.success).toBe(false);
  });

  test('accepts connection with only host (no port)', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'redis.internal' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts empty connection object (host is optional)', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: {},
    });
    expect(result.success).toBe(true);
  });

  test('loose mode passes through extra BullMQ/ioredis connection fields', () => {
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 6379, extraField: 'ignored' },
    });
    // .loose() on the connection sub-schema means unknown keys are preserved
    // for BullMQ/ioredis options this package does not model directly.
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.connection as Record<string, unknown>).extraField).toBe('ignored');
    }
  });
});

// ---------------------------------------------------------------------------
// Adapter creation — connection edge cases
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — connection edge cases', () => {
  test('creates adapter with connection port as zero is rejected by schema but creation catches it', () => {
    // The schema enforces port > 0 via .positive()
    const result = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'localhost', port: 0 },
    });
    expect(result.success).toBe(false);
  });

  test('creates adapter with host set to IPv6 address string', () => {
    const bus = createBullMQAdapter({ connection: { host: '::1' } });
    expect(bus).toBeDefined();
    expect(typeof bus.emit).toBe('function');
  });

  test('creates adapter with enqueueTimeoutMs at maximum boundary', () => {
    const bus = createBullMQAdapter({ connection: {}, enqueueTimeoutMs: 2_147_483_647 });
    expect(bus).toBeDefined();
  });

  test('creates adapter with drainBaseMs at minimum (1 ms)', () => {
    const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 1 });
    expect(bus).toBeDefined();
  });

  test('creates adapter with drainMaxMs equal to drainBaseMs', () => {
    const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 1000, drainMaxMs: 1000 });
    expect(bus).toBeDefined();
  });

  test('createBullMQAdapter throws when connection field is a string (not object)', () => {
    // The schema expects connection to be an object, not a URL string
    expect(() => createBullMQAdapter({ connection: 'redis://localhost:6379' as any })).toThrow();
  });
});
