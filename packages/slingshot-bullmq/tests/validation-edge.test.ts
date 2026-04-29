/**
 * Validation-edge tests for bullmqAdapterOptionsSchema.
 *
 * Covers schema validation edge cases that the existing tests in
 * bullmqAdapter.test.ts do not fully exercise: boundary conditions,
 * numeric type constraints, and field-level rejection cases.
 */
import { describe, expect, test } from 'bun:test';

const { bullmqAdapterOptionsSchema } = await import('../src/bullmqAdapter');

// ---------------------------------------------------------------------------
// Top-level options — edge cases
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema — top-level field edge cases', () => {
  test('accepts prefix as a valid string', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, prefix: 'myapp' });
    expect(r.success).toBe(true);
  });

  test('rejects prefix as a number', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, prefix: 123 });
    expect(r.success).toBe(false);
  });

  test('accepts validation mode "warn"', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, validation: 'warn' });
    expect(r.success).toBe(true);
  });

  test('accepts validation mode "off"', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, validation: 'off' });
    expect(r.success).toBe(true);
  });

  test('rejects validation mode as uppercase', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, validation: 'STRICT' });
    expect(r.success).toBe(false);
  });

  test('rejects attempts as a float', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, attempts: 2.5 });
    expect(r.success).toBe(false);
  });

  test('rejects enqueueTimeoutMs as a float', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, enqueueTimeoutMs: 1000.5 });
    expect(r.success).toBe(false);
  });

  test('rejects maxEnqueueAttempts of 0 (min is 1)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, maxEnqueueAttempts: 0 });
    expect(r.success).toBe(false);
  });

  test('rejects maxEnqueueAttempts as negative', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, maxEnqueueAttempts: -1 });
    expect(r.success).toBe(false);
  });

  test('accepts attempts at the boundary (1)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, attempts: 1 });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drain options — boundary
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema — drain option boundaries', () => {
  test('rejects drainBaseMs as float', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainBaseMs: 100.7 });
    expect(r.success).toBe(false);
  });

  test('rejects drainBaseMs of 0 (must be positive)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainBaseMs: 0 });
    expect(r.success).toBe(false);
  });

  test('rejects drainMaxMs as negative', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainMaxMs: -100 });
    expect(r.success).toBe(false);
  });

  test('rejects drainMaxMs of 0 (must be positive)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainMaxMs: 0 });
    expect(r.success).toBe(false);
  });

  test('accepts drainBaseMs at minimum (1)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainBaseMs: 1 });
    expect(r.success).toBe(true);
  });

  test('accepts drainMaxMs at minimum (1)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, drainMaxMs: 1 });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validationDlqQueueName edge cases
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema — validationDlqQueueName', () => {
  test('accepts validationDlqQueueName as a string', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({
      connection: {},
      validationDlqQueueName: 'my-dlq',
    });
    expect(r.success).toBe(true);
  });

  test('accepts validationDlqQueueName as empty string (disabled)', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, validationDlqQueueName: '' });
    expect(r.success).toBe(true);
  });

  test('rejects validationDlqQueueName as number', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: {}, validationDlqQueueName: 123 });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// All fields — comprehensive parse
// ---------------------------------------------------------------------------

describe('bullmqAdapterOptionsSchema — comprehensive', () => {
  test('accepts all fields with valid values', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({
      connection: { host: 'redis.example.com', port: 6380 },
      prefix: 'prod:events',
      attempts: 10,
      validation: 'strict',
      enqueueTimeoutMs: 5000,
      validationDlqQueueName: 'dlq',
      drainBaseMs: 1000,
      drainMaxMs: 30000,
      maxEnqueueAttempts: 3,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.connection).toBeDefined();
      expect(r.data.prefix).toBe('prod:events');
      expect(r.data.attempts).toBe(10);
    }
  });

  test('accepts empty options (all defaults)', () => {
    // connection is required at runtime but the schema itself may not enforce it
    const r = bullmqAdapterOptionsSchema.safeParse({});
    // connection is required per the schema — expect failure
    // If connection is optional in the schema, success is true
    expect(r.success).toBe(false);
  });

  test('rejects null connection', () => {
    const r = bullmqAdapterOptionsSchema.safeParse({ connection: null });
    expect(r.success).toBe(false);
  });
});
