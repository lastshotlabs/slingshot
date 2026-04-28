import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let sendCallCount = 0;
let sendShouldFail = false;
let capturedSendError: Error | null = null;

mock.module('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(_opts: Record<string, unknown>) {}
    async send(_command: unknown): Promise<{}> {
      sendCallCount++;
      if (sendShouldFail) {
        throw capturedSendError ?? new Error('S3 unavailable');
      }
      return {};
    }
  }

  class PutObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const { s3Storage, S3CircuitOpenError } = await import('../../src/adapters/s3');

const fakeData = Buffer.from([1, 2, 3]);
const fakeMeta = { mimeType: 'application/octet-stream', size: 3 };

beforeEach(() => {
  sendCallCount = 0;
  sendShouldFail = false;
  capturedSendError = null;
});

afterEach(() => {
  mock.restore();
});

describe('s3Storage circuit breaker', () => {
  test('starts in closed state with no consecutive failures', () => {
    const adapter = s3Storage({ bucket: 'b' });
    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
  });

  test('opens after N consecutive operation failures (threshold respected)', async () => {
    sendShouldFail = true;
    let nowMs = 1_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1, // skip retry waiting
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Drive 5 failed put() ops — each counts as one breaker failure regardless of retries.
    for (let i = 0; i < 5; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow('S3 unavailable');
      nowMs += 10;
    }

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('open');
    expect(health.consecutiveFailures).toBe(5);
    expect(health.openedAt).toBeDefined();
    expect(health.nextProbeAt).toBe(health.openedAt! + 30_000);
  });

  test('short-circuits with S3CircuitOpenError once open — does not call S3', async () => {
    sendShouldFail = true;
    let nowMs = 2_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }
    const callsBefore = sendCallCount;

    // Subsequent call must throw S3CircuitOpenError without invoking the SDK.
    let caught: unknown;
    try {
      await adapter.put('k-blocked', fakeData, fakeMeta);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(S3CircuitOpenError);
    expect((caught as { code: string }).code).toBe('S3_CIRCUIT_OPEN');
    expect(sendCallCount).toBe(callsBefore); // no new SDK call
  });

  test('failed retries inside a single op count as ONE breaker failure', async () => {
    sendShouldFail = true;
    const adapter = s3Storage({
      bucket: 'b',
      // 3 retries × 5 ops = 15 SDK calls, but only 5 breaker failures.
      retryAttempts: 3,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
      now: () => 0,
    });

    // The retry loop sleeps with setTimeout — keep delays usable but bounded by mocking.
    // (The default 500ms × attempt is fine: 3 ops × ~1500ms = ~4.5s, within test budget.)
    // To keep this test fast, bypass real sleeps:
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: TimerHandler,
      _delay?: number,
    ) => realSetTimeout(fn as () => void, 0)) as unknown as typeof setTimeout;

    try {
      for (let i = 0; i < 4; i++) {
        await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
      }

      // 4 ops × 3 SDK attempts = 12 calls, but breaker only sees 4 failures.
      expect(sendCallCount).toBe(12);
      expect(adapter.getCircuitBreakerHealth().state).toBe('closed');
      expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(4);

      // 5th op trips the breaker.
      await expect(adapter.put('k-trip', fakeData, fakeMeta)).rejects.toThrow();
      expect(adapter.getCircuitBreakerHealth().state).toBe('open');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('admits a half-open probe after cooldown elapses', async () => {
    sendShouldFail = true;
    let nowMs = 5_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // Within cooldown — short-circuit
    nowMs += 10_000;
    await expect(adapter.put('k-still-open', fakeData, fakeMeta)).rejects.toBeInstanceOf(
      S3CircuitOpenError,
    );

    // Past cooldown — admit one probe (which will still fail and re-open)
    nowMs += 30_000;
    sendShouldFail = true;
    const sdkCallsBefore = sendCallCount;
    await expect(adapter.put('k-probe', fakeData, fakeMeta)).rejects.toThrow('S3 unavailable');
    // Probe was admitted: the SDK was called.
    expect(sendCallCount).toBeGreaterThan(sdkCallsBefore);
    // Probe failed → re-opened.
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');
  });

  test('successful half-open probe closes the breaker (full reset)', async () => {
    let nowMs = 7_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker
    sendShouldFail = true;
    for (let i = 0; i < 3; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // Past cooldown + S3 has recovered
    nowMs += 31_000;
    sendShouldFail = false;
    await adapter.put('k-recover', fakeData, fakeMeta);

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
  });

  test('intervening success resets the consecutive-failure counter', async () => {
    let nowMs = 9_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // 4 failures (just under threshold)
    sendShouldFail = true;
    for (let i = 0; i < 4; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(4);

    // Recovery
    sendShouldFail = false;
    await adapter.put('k-ok', fakeData, fakeMeta);
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(0);

    // Another 4 failures should NOT trip the breaker (counter was reset)
    sendShouldFail = true;
    for (let i = 0; i < 4; i++) {
      await expect(adapter.put(`k-x-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');
  });

  test('default threshold is 5 and default cooldown is 30 000 ms', async () => {
    sendShouldFail = true;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      now: () => 1_234_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('open');
    expect(health.openedAt).toBe(1_234_000);
    expect(health.nextProbeAt).toBe(1_234_000 + 30_000);
  });

  test('S3CircuitOpenError carries retryAfterMs that decreases as time advances', async () => {
    sendShouldFail = true;
    let nowMs = 10_000_000;
    const adapter = s3Storage({
      bucket: 'b',
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    for (let i = 0; i < 3; i++) {
      await expect(adapter.put(`k-${i}`, fakeData, fakeMeta)).rejects.toThrow();
    }

    // Right after open
    let firstRetryAfter = -1;
    try {
      await adapter.put('k1', fakeData, fakeMeta);
    } catch (err) {
      if (err instanceof S3CircuitOpenError) firstRetryAfter = err.retryAfterMs;
    }
    expect(firstRetryAfter).toBeGreaterThan(0);
    expect(firstRetryAfter).toBeLessThanOrEqual(30_000);

    // Advance halfway through cooldown
    nowMs += 15_000;
    let secondRetryAfter = -1;
    try {
      await adapter.put('k2', fakeData, fakeMeta);
    } catch (err) {
      if (err instanceof S3CircuitOpenError) secondRetryAfter = err.retryAfterMs;
    }
    expect(secondRetryAfter).toBeLessThan(firstRetryAfter);
  });
});
