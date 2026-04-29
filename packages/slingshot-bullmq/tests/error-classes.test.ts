/**
 * Unit tests for the BullMQ adapter error classes.
 *
 * These classes live in src/errors.ts and are exported from the package index.
 * They are plain Error subclasses — no mock.module or fake module needed.
 */
import { describe, expect, test } from 'bun:test';

const {
  BullMQAdapterError,
  DurableSubscriptionNameRequiredError,
  DuplicateDurableSubscriptionError,
  DurableSubscriptionOffError,
} = await import('../src/errors');

// ---------------------------------------------------------------------------
// BullMQAdapterError (base class)
// ---------------------------------------------------------------------------

describe('BullMQAdapterError', () => {
  test('is an Error subclass with the correct name', () => {
    const err = new BullMQAdapterError('something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BullMQAdapterError);
    expect(err.name).toBe('BullMQAdapterError');
  });

  test('preserves the constructor message', () => {
    const msg = 'custom adapter error message';
    const err = new BullMQAdapterError(msg);
    expect(err.message).toBe(msg);
  });

  test('has a stack trace', () => {
    const err = new BullMQAdapterError('with stack');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('BullMQAdapterError');
  });

  test('has a message property with the expected value', () => {
    const err = new BullMQAdapterError('clean error');
    expect(err.message).toBe('clean error');
  });
});

// ---------------------------------------------------------------------------
// DurableSubscriptionNameRequiredError
// ---------------------------------------------------------------------------

describe('DurableSubscriptionNameRequiredError', () => {
  test('extends BullMQAdapterError', () => {
    const err = new DurableSubscriptionNameRequiredError();
    expect(err).toBeInstanceOf(BullMQAdapterError);
    expect(err).toBeInstanceOf(DurableSubscriptionNameRequiredError);
  });

  test('has the correct name', () => {
    const err = new DurableSubscriptionNameRequiredError();
    expect(err.name).toBe('DurableSubscriptionNameRequiredError');
  });

  test('message guides the caller to pass opts.name', () => {
    const err = new DurableSubscriptionNameRequiredError();
    expect(err.message).toMatch(/durable subscriptions require a name/i);
    expect(err.message).toMatch(/opts\.name/i);
  });

  test('constructor takes no arguments and succeeds', () => {
    const err = new DurableSubscriptionNameRequiredError();
    expect(err.message).toBeTruthy();
    expect(err.name).toBe('DurableSubscriptionNameRequiredError');
  });
});

// ---------------------------------------------------------------------------
// DuplicateDurableSubscriptionError
// ---------------------------------------------------------------------------

describe('DuplicateDurableSubscriptionError', () => {
  test('extends BullMQAdapterError', () => {
    const err = new DuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err).toBeInstanceOf(BullMQAdapterError);
    expect(err).toBeInstanceOf(DuplicateDurableSubscriptionError);
  });

  test('has the correct name', () => {
    const err = new DuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err.name).toBe('DuplicateDurableSubscriptionError');
  });

  test('includes event and subscription name in the message', () => {
    const err = new DuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err.message).toContain('auth:login');
    expect(err.message).toContain('audit');
    expect(err.message).toMatch(/already exists/i);
  });

  test('different event or name produces a distinct message', () => {
    const err1 = new DuplicateDurableSubscriptionError('auth:login', 'audit');
    const err2 = new DuplicateDurableSubscriptionError('auth:logout', 'audit');
    expect(err2.message).toContain('auth:logout');
    expect(err1.message).not.toEqual(err2.message);

    const err3 = new DuplicateDurableSubscriptionError('auth:login', 'indexer');
    expect(err3.message).toContain('indexer');
    expect(err1.message).not.toEqual(err3.message);
  });

  test('is thrown by the adapter when a duplicate is registered', async () => {
    // Dynamic import inside test to avoid hoisting issues with mock.module
    const { createFakeBullMQModule, fakeBullMQState } = await import('../src/testing/fakeBullMQ');
    const { mock } = await import('bun:test');
    mock.module('bullmq', () => createFakeBullMQModule());

    const { createBullMQAdapter } = await import('../src/bullmqAdapter');
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'dup-test' });
    expect(() =>
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'dup-test' }),
    ).toThrow(DuplicateDurableSubscriptionError);
    fakeBullMQState.reset();
  });
});

// ---------------------------------------------------------------------------
// DurableSubscriptionOffError
// ---------------------------------------------------------------------------

describe('DurableSubscriptionOffError', () => {
  test('extends BullMQAdapterError', () => {
    const err = new DurableSubscriptionOffError();
    expect(err).toBeInstanceOf(BullMQAdapterError);
    expect(err).toBeInstanceOf(DurableSubscriptionOffError);
  });

  test('has the correct name', () => {
    const err = new DurableSubscriptionOffError();
    expect(err.name).toBe('DurableSubscriptionOffError');
  });

  test('message mentions shutdown as the alternative', () => {
    const err = new DurableSubscriptionOffError();
    expect(err.message).toMatch(/cannot remove a durable subscription/i);
    expect(err.message).toMatch(/shutdown\(\)/i);
  });

  test('constructor takes no arguments', () => {
    const err = new DurableSubscriptionOffError();
    expect(err.message).toBeTruthy();
  });
});
