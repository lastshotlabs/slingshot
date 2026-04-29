/**
 * Unit tests for all Kafka adapter and connector error classes.
 *
 * These classes live in src/errors.ts and are exported from the package index.
 * They are plain Error subclasses — no mock.module or fake module needed.
 */
import { describe, expect, test } from 'bun:test';

// All error classes from the same module
const {
  KafkaAdapterError,
  KafkaAdapterConfigError,
  KafkaDurableSubscriptionNameRequiredError,
  KafkaDuplicateDurableSubscriptionError,
  KafkaDurableSubscriptionOffError,
  KafkaConnectorError,
  KafkaConnectorValidationError,
  KafkaConnectorMessageIdError,
  KafkaDuplicateConnectorError,
  KafkaConnectorStateError,
} = await import('../../src/errors');

// ---------------------------------------------------------------------------
// KafkaAdapterError (base class for adapter errors)
// ---------------------------------------------------------------------------

describe('KafkaAdapterError', () => {
  test('is an Error subclass', () => {
    const err = new KafkaAdapterError('something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KafkaAdapterError);
  });

  test('has the correct name', () => {
    const err = new KafkaAdapterError('test');
    expect(err.name).toBe('KafkaAdapterError');
  });

  test('preserves constructor message', () => {
    const err = new KafkaAdapterError('kafka broker unavailable');
    expect(err.message).toBe('kafka broker unavailable');
  });
});

// ---------------------------------------------------------------------------
// KafkaAdapterConfigError
// ---------------------------------------------------------------------------

describe('KafkaAdapterConfigError', () => {
  test('extends KafkaAdapterError', () => {
    const err = new KafkaAdapterConfigError('bad config');
    expect(err).toBeInstanceOf(KafkaAdapterError);
    expect(err).toBeInstanceOf(KafkaAdapterConfigError);
  });

  test('has the correct name', () => {
    const err = new KafkaAdapterConfigError('bad config');
    expect(err.name).toBe('KafkaAdapterConfigError');
  });
});

// ---------------------------------------------------------------------------
// KafkaDurableSubscriptionNameRequiredError
// ---------------------------------------------------------------------------

describe('KafkaDurableSubscriptionNameRequiredError', () => {
  test('extends KafkaAdapterError', () => {
    const err = new KafkaDurableSubscriptionNameRequiredError();
    expect(err).toBeInstanceOf(KafkaAdapterError);
    expect(err).toBeInstanceOf(KafkaDurableSubscriptionNameRequiredError);
  });

  test('has the correct name', () => {
    const err = new KafkaDurableSubscriptionNameRequiredError();
    expect(err.name).toBe('KafkaDurableSubscriptionNameRequiredError');
  });

  test('message guides the caller to pass opts.name', () => {
    const err = new KafkaDurableSubscriptionNameRequiredError();
    expect(err.message).toMatch(/durable subscriptions require a name/i);
    expect(err.message).toMatch(/opts\.name/i);
  });
});

// ---------------------------------------------------------------------------
// KafkaDuplicateDurableSubscriptionError
// ---------------------------------------------------------------------------

describe('KafkaDuplicateDurableSubscriptionError', () => {
  test('extends KafkaAdapterError', () => {
    const err = new KafkaDuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err).toBeInstanceOf(KafkaAdapterError);
    expect(err).toBeInstanceOf(KafkaDuplicateDurableSubscriptionError);
  });

  test('has the correct name', () => {
    const err = new KafkaDuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err.name).toBe('KafkaDuplicateDurableSubscriptionError');
  });

  test('includes event and subscription name in message', () => {
    const err = new KafkaDuplicateDurableSubscriptionError('auth:login', 'audit');
    expect(err.message).toContain('auth:login');
    expect(err.message).toContain('audit');
    expect(err.message).toMatch(/already exists/i);
  });

  test('different event produces a distinct message', () => {
    const err1 = new KafkaDuplicateDurableSubscriptionError('auth:login', 'audit');
    const err2 = new KafkaDuplicateDurableSubscriptionError('auth:logout', 'audit');
    expect(err2.message).toContain('auth:logout');
    expect(err1.message).not.toEqual(err2.message);
  });
});

// ---------------------------------------------------------------------------
// KafkaDurableSubscriptionOffError
// ---------------------------------------------------------------------------

describe('KafkaDurableSubscriptionOffError', () => {
  test('extends KafkaAdapterError', () => {
    const err = new KafkaDurableSubscriptionOffError();
    expect(err).toBeInstanceOf(KafkaAdapterError);
    expect(err).toBeInstanceOf(KafkaDurableSubscriptionOffError);
  });

  test('has the correct name', () => {
    const err = new KafkaDurableSubscriptionOffError();
    expect(err.name).toBe('KafkaDurableSubscriptionOffError');
  });

  test('message mentions shutdown as alternative', () => {
    const err = new KafkaDurableSubscriptionOffError();
    expect(err.message).toMatch(/cannot remove a durable subscription/i);
    expect(err.message).toMatch(/shutdown\(\)/i);
  });
});

// ---------------------------------------------------------------------------
// KafkaConnectorError (base class for connector errors)
// ---------------------------------------------------------------------------

describe('KafkaConnectorError', () => {
  test('is an Error subclass', () => {
    const err = new KafkaConnectorError('connector problem');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KafkaConnectorError);
  });

  test('has the correct name', () => {
    const err = new KafkaConnectorError('test');
    expect(err.name).toBe('KafkaConnectorError');
  });

  test('is NOT an instance of KafkaAdapterError (separate hierarchy)', () => {
    const err = new KafkaConnectorError('sep');
    expect(err).not.toBeInstanceOf(KafkaAdapterError);
  });
});

// ---------------------------------------------------------------------------
// KafkaConnectorValidationError
// ---------------------------------------------------------------------------

describe('KafkaConnectorValidationError', () => {
  test('extends KafkaConnectorError', () => {
    const err = new KafkaConnectorValidationError('invalid payload', { issues: [] });
    expect(err).toBeInstanceOf(KafkaConnectorError);
    expect(err).toBeInstanceOf(KafkaConnectorValidationError);
  });

  test('has the correct name', () => {
    const err = new KafkaConnectorValidationError('invalid', { issues: [] });
    expect(err.name).toBe('KafkaConnectorValidationError');
  });

  test('carries the zodError as a readonly property', () => {
    const zodError = { issues: [{ code: 'custom', message: 'too short' }] };
    const err = new KafkaConnectorValidationError('invalid payload', zodError);
    expect(err.zodError).toBe(zodError);
    expect(err.zodError).toEqual({ issues: [{ code: 'custom', message: 'too short' }] });
  });

  test('zodError is independently accessible', () => {
    const zodError = new Error('simulated zod error');
    const err = new KafkaConnectorValidationError('nope', zodError);
    expect(err.zodError).toBe(zodError);
    expect(err.message).toContain('nope');
  });
});

// ---------------------------------------------------------------------------
// KafkaConnectorMessageIdError
// ---------------------------------------------------------------------------

describe('KafkaConnectorMessageIdError', () => {
  test('extends KafkaConnectorError', () => {
    const err = new KafkaConnectorMessageIdError('auth:login');
    expect(err).toBeInstanceOf(KafkaConnectorError);
    expect(err).toBeInstanceOf(KafkaConnectorMessageIdError);
  });

  test('has the correct name', () => {
    const err = new KafkaConnectorMessageIdError('auth:login');
    expect(err.name).toBe('KafkaConnectorMessageIdError');
  });

  test('includes the event name in message', () => {
    const err = new KafkaConnectorMessageIdError('user:created');
    expect(err.message).toContain('user:created');
    expect(err.message).toMatch(/no messageId/i);
    expect(err.message).toMatch(/onIdMissing.*reject/i);
  });
});

// ---------------------------------------------------------------------------
// KafkaDuplicateConnectorError
// ---------------------------------------------------------------------------

describe('KafkaDuplicateConnectorError', () => {
  test('extends KafkaConnectorError', () => {
    const err = new KafkaDuplicateConnectorError('inbound:orders');
    expect(err).toBeInstanceOf(KafkaConnectorError);
    expect(err).toBeInstanceOf(KafkaDuplicateConnectorError);
  });

  test('has the correct name', () => {
    const err = new KafkaDuplicateConnectorError('inbound:orders');
    expect(err.name).toBe('KafkaDuplicateConnectorError');
  });

  test('includes the duplicate key in message', () => {
    const err = new KafkaDuplicateConnectorError('inbound:orders');
    expect(err.message).toContain('duplicate connector');
    expect(err.message).toContain('inbound:orders');
  });
});

// ---------------------------------------------------------------------------
// KafkaConnectorStateError
// ---------------------------------------------------------------------------

describe('KafkaConnectorStateError', () => {
  test('extends KafkaConnectorError', () => {
    const err = new KafkaConnectorStateError('start', 'running');
    expect(err).toBeInstanceOf(KafkaConnectorError);
    expect(err).toBeInstanceOf(KafkaConnectorStateError);
  });

  test('has the correct name', () => {
    const err = new KafkaConnectorStateError('start', 'running');
    expect(err.name).toBe('KafkaConnectorStateError');
  });

  test('includes operation and current state in message', () => {
    const err = new KafkaConnectorStateError('stop', 'stopped');
    expect(err.message).toContain('stop');
    expect(err.message).toContain('stopped');
    expect(err.message).toMatch(/only valid from/i);
  });

  test('different operation and state produce distinct messages', () => {
    const err1 = new KafkaConnectorStateError('start', 'running');
    const err2 = new KafkaConnectorStateError('stop', 'stopped');
    expect(err1.message).toContain('start');
    expect(err1.message).toContain('running');
    expect(err2.message).toContain('stop');
    expect(err2.message).toContain('stopped');
    expect(err1.message).not.toEqual(err2.message);
  });

  test('is thrown by the connectors start/stop state machine', async () => {
    // Integration-level verification: the connectors.start/stop methods
    // throw KafkaConnectorStateError on illegal transitions.
    const { createFakeKafkaJsModule, fakeKafkaState, resetFakeKafkaState } =
      await import('../../src/testing/fakeKafkaJs');
    const { mock } = await import('bun:test');
    mock.module('kafkajs', () => createFakeKafkaJsModule());

    const { createKafkaConnectors } = await import('../../src/kafkaConnectors');
    const connectors = createKafkaConnectors({ brokers: ['localhost:19092'] });
    // stop() before start() should throw
    await expect(connectors.stop()).rejects.toThrow(KafkaConnectorStateError);
    resetFakeKafkaState();
  });
});
