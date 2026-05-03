/**
 * Property-based / fuzz tests for config and event-key validation in the BullMQ
 * adapter.
 *
 * Tests random connection configs, random event keys, and boundary values
 * against `bullmqAdapterOptionsSchema` and the adapter's runtime behaviour.
 * The `sanitizeQueueName` function (which replaces `:` with `_`) is exercised
 * indirectly through the adapter's handling of event names with colons.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ZodError } from 'zod';
import { createFakeBullMQModule, fakeBullMQState } from '../../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());
const { createBullMQAdapter, bullmqAdapterOptionsSchema } = await import('../../src/bullmqAdapter');

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomString(rng: () => number, maxLen: number): string {
  const pool =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_:.-!@#$%^&*()\n\r\t😀👍🎉' +
    "' OR 1=1--" +
    '"; DROP TABLE--' +
    '<script>alert(1)</script>';
  const len = randomInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += pool[Math.floor(rng() * pool.length)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema-level fuzz tests
// ---------------------------------------------------------------------------
describe('bullmqAdapterOptionsSchema fuzz', () => {
  test('200 random valid-like configs are accepted or produce clear ZodError', () => {
    const rng = seededRandom(42);

    for (let i = 0; i < 200; i++) {
      const config: Record<string, unknown> = {};

      // Random connection config
      const connection: Record<string, unknown> = {};
      if (rng() > 0.3) connection.host = randomString(rng, 50);
      if (rng() > 0.5) connection.port = randomInt(rng, 1, 65535);
      config.connection = connection;

      // Random optional fields
      if (rng() > 0.6) config.prefix = randomString(rng, 30);
      if (rng() > 0.6) config.attempts = randomInt(rng, 1, 20);
      if (rng() > 0.7) {
        const modes = ['strict', 'warn', 'off'] as const;
        config.validation = modes[randomInt(rng, 0, 2)];
      }
      if (rng() > 0.7) config.enqueueTimeoutMs = randomInt(rng, 1, 60000);
      if (rng() > 0.7) config.drainBaseMs = randomInt(rng, 1, 30000);
      if (rng() > 0.7) config.drainMaxMs = randomInt(rng, 1, 120000);
      if (rng() > 0.7) config.maxEnqueueAttempts = randomInt(rng, 1, 20);
      if (rng() > 0.8) config.walCompactThreshold = randomInt(rng, 1, 10000);

      // Must not throw non-Zod errors
      try {
        bullmqAdapterOptionsSchema.parse(config);
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
      }
    }
  });

  test('port boundary values', () => {
    const valid = [1, 1024, 65535, 6379, 0xffff, 65536];
    for (const port of valid) {
      expect(() => bullmqAdapterOptionsSchema.parse({ connection: { port } })).not.toThrow();
    }

    const invalid = [0, -1, 3.14, NaN, Infinity];
    for (const port of invalid) {
      expect(() => bullmqAdapterOptionsSchema.parse({ connection: { port } })).toThrow(ZodError);
    }
  });

  test('attempts boundary values', () => {
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, attempts: 1 })).not.toThrow();
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, attempts: 100 })).not.toThrow();
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, attempts: 0 })).toThrow(
      ZodError,
    );
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, attempts: -1 })).toThrow(
      ZodError,
    );
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, attempts: 3.5 })).toThrow(
      ZodError,
    );
  });

  test('validation field rejects garbage values', () => {
    const garbage = ['strict-ish', '', 'WARN', 'Strict', null, 42, true, []];
    for (const val of garbage) {
      expect(() =>
        bullmqAdapterOptionsSchema.parse({ connection: {}, validation: val as any }),
      ).toThrow(ZodError);
    }
  });

  test('empty connection object is accepted', () => {
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {} })).not.toThrow();
  });

  test('non-object connection is rejected', () => {
    const garbage = [null, 'string', 42, true, []];
    for (const conn of garbage) {
      expect(() => bullmqAdapterOptionsSchema.parse({ connection: conn as any })).toThrow(ZodError);
    }
  });

  test('enqueueTimeoutMs boundary values', () => {
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, enqueueTimeoutMs: 1 }),
    ).not.toThrow();
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, enqueueTimeoutMs: 300000 }),
    ).not.toThrow();
    expect(() => bullmqAdapterOptionsSchema.parse({ connection: {}, enqueueTimeoutMs: 0 })).toThrow(
      ZodError,
    );
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, enqueueTimeoutMs: -100 }),
    ).toThrow(ZodError);
  });

  test('walCompactThreshold boundary', () => {
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, walCompactThreshold: 1 }),
    ).not.toThrow();
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, walCompactThreshold: 0 }),
    ).toThrow(ZodError);
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, walCompactThreshold: -5 }),
    ).toThrow(ZodError);
  });

  test('very long prefix string is accepted', () => {
    const rng = seededRandom(1);
    const longStr = randomString(rng, 5000);
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, prefix: longStr }),
    ).not.toThrow();
  });

  test('very long walPath string is accepted', () => {
    const rng = seededRandom(2);
    const longStr = '/tmp/' + randomString(rng, 4000);
    expect(() =>
      bullmqAdapterOptionsSchema.parse({ connection: {}, walPath: longStr }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Event key and sanitization fuzz — exercised through adapter runtime
// ===========================================================================
describe('event key sanitization fuzz', () => {
  afterEach(() => {
    fakeBullMQState.reset();
  });

  test('event keys with colons are handled without crash', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const eventKey = 'entity:post.created:v2';

    let called = false;
    bus.on(eventKey as any, async () => {
      called = true;
    });
    bus.emit(eventKey as any, { ok: true } as any);

    expect(called).toBe(true);
    await bus.shutdown();
  });

  test('event keys with special characters do not crash adapter', async () => {
    const rng = seededRandom(42);
    const bus = createBullMQAdapter({ connection: {} });

    for (let i = 0; i < 50; i++) {
      const key = randomString(rng, 30);
      let called = false;
      bus.on(key as any, async () => {
        called = true;
      });
      bus.emit(key as any, { seq: i } as any);
      expect(called).toBe(true);
    }

    await bus.shutdown();
  });

  test('durable subscriptions with colons in event name create sanitized queue names', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const eventKey = 'namespace:entity:created';

    bus.on(eventKey as any, async () => {}, { durable: true, name: 'my-indexer' });

    // The fake queue should have been created with name where ':' -> '_'
    expect(fakeBullMQState.queues.length).toBeGreaterThan(0);
    const queueName = fakeBullMQState.queues[0]?.name;
    expect(queueName).not.toContain(':');

    await bus.shutdown();
  });

  test('SQL injection attempt in event key is handled gracefully', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const sqlKeys = [
      "entity:post:created' OR 1=1--",
      'entity:post:created"; DROP TABLE events--',
      "'; EXEC xp_cmdshell 'dir'--",
    ];

    for (const key of sqlKeys) {
      let called = false;
      bus.on(key as any, async () => {
        called = true;
      });
      bus.emit(key as any, { ok: true } as any);
      expect(called).toBe(true);
    }

    await bus.shutdown();
  });

  test('emoji event keys are handled without crash', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const emojiKeys = ['user:😀:login', '👍:notification', '🎉:🎉:🎉', 'order:created:🏷️'];

    for (const key of emojiKeys) {
      let called = false;
      bus.on(key as any, async () => {
        called = true;
      });
      bus.emit(key as any, { emoji: true } as any);
      expect(called).toBe(true);
    }

    await bus.shutdown();
  });

  test('durable subscription with colon in event name creates valid queue name', async () => {
    const bus = createBullMQAdapter({ connection: {} });

    // These event names contain colons which must be sanitized to '_' in queue names
    bus.on('entity:post.created' as any, async () => {}, { durable: true, name: 'indexer' });
    bus.on('namespace:entity:created' as any, async () => {}, { durable: true, name: 'worker' });

    for (const q of fakeBullMQState.queues) {
      expect(q.name).not.toMatch(/:/);
    }

    await bus.shutdown();
  });

  test('empty event key does not crash adapter', async () => {
    const bus = createBullMQAdapter({ connection: {} });

    let called = false;
    bus.on('' as any, async () => {
      called = true;
    });
    bus.emit('' as any, { ok: true } as any);

    expect(called).toBe(true);
    await bus.shutdown();
  });

  test('very long event key does not crash adapter', async () => {
    const rng = seededRandom(99);
    const longKey = randomString(rng, 5000);
    const bus = createBullMQAdapter({ connection: {} });

    let called = false;
    bus.on(longKey as any, async () => {
      called = true;
    });
    bus.emit(longKey as any, { ok: true } as any);

    expect(called).toBe(true);
    await bus.shutdown();
  });

  test('200 random event keys through durable subscription lifecycle', async () => {
    const rng = seededRandom(77);
    const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 50, drainMaxMs: 200 });

    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const key = 'event:' + randomString(rng, 15).replace(/:/g, '_').substring(0, 20);
      keys.push(key);
      bus.on(key as any, async () => {}, { durable: true, name: `durable-${i}` });
      bus.emit(key as any, { seq: i } as any);
    }

    // All 200 durable subscriptions should have created queues with sanitized names
    expect(fakeBullMQState.queues.length).toBe(200);

    // All queue names must be colon-free (BullMQ constraint)
    for (const q of fakeBullMQState.queues) {
      expect(q.name).not.toContain(':');
    }

    await bus.shutdown();
  });
});

// ===========================================================================
// Adapter creation with edge-case configs
// ===========================================================================
describe('adapter creation fuzz', () => {
  afterEach(() => {
    fakeBullMQState.reset();
  });

  test('100 random configs create adapter without throwing', () => {
    const rng = seededRandom(42);

    for (let i = 0; i < 100; i++) {
      const config: Record<string, unknown> = {
        connection: {
          host: rng() > 0.3 ? randomString(rng, 30) : undefined,
          port: rng() > 0.5 ? randomInt(rng, 1, 65535) : undefined,
        },
      };
      if (rng() > 0.6) config.prefix = randomString(rng, 20);
      if (rng() > 0.7) config.attempts = randomInt(rng, 1, 10);
      if (rng() > 0.8) config.drainBaseMs = randomInt(rng, 100, 10000);

      // Creation must not throw (validation errors are surfaced as ZodError,
      // not crashes)
      expect(() => createBullMQAdapter(config as any)).not.toThrow();
    }
  });

  test('adapter creation with maximum boundary values', () => {
    const config = {
      connection: { host: 'a'.repeat(1000), port: 65535 },
      prefix: 'x'.repeat(5000),
      attempts: 1000000,
      enqueueTimeoutMs: 86400000,
      drainBaseMs: 1,
      drainMaxMs: Number.MAX_SAFE_INTEGER,
      maxEnqueueAttempts: 1000,
      walCompactThreshold: Number.MAX_SAFE_INTEGER,
    };
    expect(() => createBullMQAdapter(config as any)).not.toThrow();
  });
});
