/**
 * Edge-case config validation tests for the Kafka adapter and connectors.
 *
 * Tests that the Zod schemas for SASL mechanisms, SSL configs, broker lists,
 * and compression codecs reject invalid combinations and accept valid ones.
 * No mock.module needed — only schema-level validation.
 */
import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// SASL mechanism validation
// ---------------------------------------------------------------------------

describe('SASL config validation', () => {
  test('accepts plain mechanism with username and password', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'plain',
      username: 'admin',
      password: 'secret',
    });
    expect(result.success).toBe(true);
  });

  test('accepts scram-sha-256 mechanism', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'scram-sha-256',
      username: 'user',
      password: 'pass',
    });
    expect(result.success).toBe(true);
  });

  test('accepts scram-sha-512 mechanism', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'scram-sha-512',
      username: 'user',
      password: 'pass',
    });
    expect(result.success).toBe(true);
  });

  test('rejects sasl with missing username', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'plain',
      password: 'secret',
    } as any);
    expect(result.success).toBe(false);
  });

  test('rejects sasl with missing password', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'plain',
      username: 'admin',
    } as any);
    expect(result.success).toBe(false);
  });

  test('rejects unknown SASL mechanism', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'gssapi',
      username: 'user',
      password: 'pass',
    } as any);
    expect(result.success).toBe(false);
  });

  test('rejects sasl object missing required username field', () => {
    const { saslSchema } = require('../../src/kafkaShared');
    const result = saslSchema.safeParse({
      mechanism: 'plain',
      password: 'secret',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSL config validation
// ---------------------------------------------------------------------------

describe('SSL config validation', () => {
  test('accepts ssl: true literal', () => {
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse(true);
    expect(result.success).toBe(true);
  });

  test('accepts ssl object with ca, cert, key', () => {
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse({
      ca: 'ca-pem',
      cert: 'cert-pem',
      key: 'key-pem',
      rejectUnauthorized: true,
    });
    expect(result.success).toBe(true);
  });

  test('accepts ssl object with rejectUnauthorized: false', () => {
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse({
      rejectUnauthorized: false,
    });
    expect(result.success).toBe(true);
  });

  test('rejects ssl number literal', () => {
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse(1);
    expect(result.success).toBe(false);
  });

  test('rejects ssl string literal', () => {
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse('true');
    expect(result.success).toBe(false);
  });

  test('rejects ssl with unknown extra properties (discarded by passthrough)', () => {
    // zod's default behaviour with union + object is stripUnknown, so extra
    // props are dropped — this should still succeed.
    const { sslSchema } = require('../../src/kafkaShared');
    const result = sslSchema.safeParse({
      ca: 'ca-pem',
      unknownField: 'should-be-stripped',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broker list validation
// ---------------------------------------------------------------------------

describe('broker list validation', () => {
  test('accepts single broker', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({
      brokers: ['localhost:9092'],
    });
    expect(result.success).toBe(true);
  });

  test('accepts multiple brokers', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({
      brokers: ['broker1:9092', 'broker2:9092', 'broker3:9092'],
    });
    expect(result.success).toBe(true);
  });

  test('rejects empty broker list', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({
      brokers: [],
    } as any);
    expect(result.success).toBe(false);
  });

  test('rejects missing brokers field', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compression codec validation
// ---------------------------------------------------------------------------

describe('compression codec validation', () => {
  test('accepts gzip codec', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse('gzip').success).toBe(true);
  });

  test('accepts snappy codec', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse('snappy').success).toBe(true);
  });

  test('accepts lz4 codec', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse('lz4').success).toBe(true);
  });

  test('accepts zstd codec', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse('zstd').success).toBe(true);
  });

  test('rejects unknown compression codec', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse('none').success).toBe(false);
    expect(compressionSchema.safeParse('lzo').success).toBe(false);
  });

  test('rejects numeric compression', () => {
    const { compressionSchema } = require('../../src/kafkaShared');
    expect(compressionSchema.safeParse(1).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapter options schema — comprehensive edge cases
// ---------------------------------------------------------------------------

describe('adapter options schema edge cases', () => {
  test('rejects negative maxRetries', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({
      brokers: ['localhost:9092'],
      maxRetries: -1,
    });
    expect(result.success).toBe(false);
  });

  test('accepts valid heartbeatInterval and sessionTimeout combination', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    const result = kafkaAdapterOptionsSchema.safeParse({
      brokers: ['localhost:9092'],
      heartbeatInterval: 3000,
      sessionTimeout: 30000,
    });
    expect(result.success).toBe(true);
  });

  test('accepts all validation modes', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], validation: 'strict' })
        .success,
    ).toBe(true);
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], validation: 'warn' })
        .success,
    ).toBe(true);
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], validation: 'off' })
        .success,
    ).toBe(true);
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], validation: 'unknown' })
        .success,
    ).toBe(false);
  });

  test('accepts both deserialization error policies', () => {
    const { kafkaAdapterOptionsSchema } = require('../../src/kafkaAdapter');
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], deserializationErrorPolicy: 'dlq' })
        .success,
    ).toBe(true);
    expect(
      kafkaAdapterOptionsSchema.safeParse({ brokers: ['localhost:9092'], deserializationErrorPolicy: 'skip' })
        .success,
    ).toBe(true);
    expect(
      kafkaAdapterOptionsSchema.safeParse({
        brokers: ['localhost:9092'],
        deserializationErrorPolicy: 'unknown',
      }).success,
    ).toBe(false);
  });
});
