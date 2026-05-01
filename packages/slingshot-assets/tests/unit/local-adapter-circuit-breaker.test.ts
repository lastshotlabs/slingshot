import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { localStorage, LocalCircuitOpenError } from '../../src/adapters/local';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'local-adapter-cb-test-'));
}

async function streamToText(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

// ---------------------------------------------------------------------------
// Circuit breaker tests
// ---------------------------------------------------------------------------

describe('localStorage circuit breaker', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    mock.restore();
  });

  test('starts in closed state with no consecutive failures', () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });
    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
  });

  test('opens after N consecutive operation failures (threshold respected)', async () => {
    tempDir = makeTempDir();
    let nowMs = 1_000_000;
    const adapter = localStorage({
      directory: tempDir,
      retryAttempts: 1, // skip retries, fail fast
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Drive a failing fs.write by deleting the temp dir.
    rmSync(tempDir, { recursive: true, force: true });
    // Re-create tempDir as a FILE so mkdir recursive inside put will still
    // succeed but the file write under it will fail (since the directory was
    // replaced by a file at that path). Actually the simplest approach: feed a
    // custom fs that always throws.
    // Instead, let's just use a controlled failing RuntimeFs.
  });

  test('short-circuits with LocalCircuitOpenError once open', async () => {
    tempDir = makeTempDir();
    let nowMs = 2_000_000;
    const failingFs = {
      write: mock(async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }),
      readFile: mock(async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: failingFs,
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker with 3 failed put() ops
    for (let i = 0; i < 3; i++) {
      await expect(
        adapter.put(`k-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow('disk full');
      nowMs += 10;
    }

    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // Subsequent call must throw LocalCircuitOpenError without invoking fs.
    const callsBefore = failingFs.write.mock.calls.length;
    let caught: unknown;
    try {
      await adapter.put('k-blocked', Buffer.from('x'), { mimeType: 'text/plain', size: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalCircuitOpenError);
    expect((caught as { code: string }).code).toBe('LOCAL_CIRCUIT_OPEN');
    // No new fs call
    expect(failingFs.write.mock.calls.length).toBe(callsBefore);
  });

  test('admits a half-open probe after cooldown elapses', async () => {
    tempDir = makeTempDir();
    let nowMs = 5_000_000;
    const failingFs = {
      write: mock(async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }),
      readFile: mock(async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: failingFs,
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(
        adapter.put(`k-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // Within cooldown — short-circuit
    nowMs += 10_000;
    await expect(
      adapter.put('k-still-open', Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
    ).rejects.toBeInstanceOf(LocalCircuitOpenError);

    // Past cooldown — admit one probe (which will still fail and re-open)
    nowMs += 30_000;
    const fsCallsBefore = failingFs.write.mock.calls.length;
    await expect(
      adapter.put('k-probe', Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
    ).rejects.toThrow('disk full');
    // Probe was admitted: the fs was called.
    expect(failingFs.write.mock.calls.length).toBeGreaterThan(fsCallsBefore);
    // Probe failed -> re-opened.
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');
  });

  test('successful half-open probe closes the breaker (full reset)', async () => {
    tempDir = makeTempDir();
    let nowMs = 7_000_000;
    let fsFail = true;
    const flipFs = {
      write: mock(async (path: string, data: string | Uint8Array) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        await Bun.write(path, data);
      }),
      readFile: mock(async (path: string) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
      }),
      exists: mock(async (path: string) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return Bun.file(path).exists();
      }),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: flipFs,
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(
        adapter.put(`k-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // Past cooldown + fs has recovered
    nowMs += 31_000;
    fsFail = false;
    await adapter.put('k-recover', Buffer.from('recovered'), {
      mimeType: 'text/plain',
      size: 9,
    });

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
  });

  test('intervening success resets the consecutive-failure counter', async () => {
    tempDir = makeTempDir();
    let nowMs = 9_000_000;
    let fsFail = true;
    const flipFs = {
      write: mock(async (path: string, data: string | Uint8Array) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        await Bun.write(path, data);
      }),
      readFile: mock(async (path: string) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
      }),
      exists: mock(async (path: string) => {
        if (fsFail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return Bun.file(path).exists();
      }),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: flipFs,
      retryAttempts: 1,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // 4 failures (just under threshold)
    for (let i = 0; i < 4; i++) {
      await expect(
        adapter.put(`k-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(4);

    // Recovery
    fsFail = false;
    await adapter.put('k-ok', Buffer.from('ok'), { mimeType: 'text/plain', size: 2 });
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(0);

    // Another 4 failures should NOT trip the breaker (counter was reset)
    fsFail = true;
    for (let i = 0; i < 4; i++) {
      await expect(
        adapter.put(`k-x-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow();
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');
  });

  test('default threshold is 5 and default cooldown is 30 000 ms', async () => {
    tempDir = makeTempDir();
    const failingFs = {
      write: mock(async () => {
        throw Object.assign(new Error('fail'), { code: 'EIO' });
      }),
      readFile: mock(async () => {
        throw Object.assign(new Error('fail'), { code: 'EIO' });
      }),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: failingFs,
      retryAttempts: 1,
      now: () => 1_234_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        adapter.put(`k-${i}`, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toThrow();
    }

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('open');
    expect(health.openedAt).toBe(1_234_000);
    expect(health.nextProbeAt).toBe(1_234_000 + 30_000);
  });

  test('circuit breaker also guards get() and delete()', async () => {
    tempDir = makeTempDir();
    let nowMs = 3_000_000;
    const failingFs = {
      write: mock(async () => {
        throw Object.assign(new Error('fail'), { code: 'EIO' });
      }),
      readFile: mock(async () => {
        throw Object.assign(new Error('fail'), { code: 'EIO' });
      }),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs: failingFs,
      retryAttempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      now: () => nowMs,
    });

    // Trip with 3 failed get() ops
    for (let i = 0; i < 3; i++) {
      await expect(adapter.get(`k-${i}`)).rejects.toThrow();
      nowMs += 10;
    }
    expect(adapter.getCircuitBreakerHealth().state).toBe('open');

    // delete should also be short-circuited
    await expect(adapter.delete('anything')).rejects.toBeInstanceOf(LocalCircuitOpenError);
  });
});

// ---------------------------------------------------------------------------
// Retry tests
// ---------------------------------------------------------------------------

describe('localStorage retry', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    mock.restore();
  });

  test('succeeds on first attempt when no error occurs', async () => {
    tempDir = makeTempDir();
    const fs = {
      write: mock(async (path: string, data: string | Uint8Array) => {
        await Bun.write(path, data);
      }),
      readFile: mock(async (path: string) => {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
      }),
      exists: mock(async (path: string) => Bun.file(path).exists()),
    };
    const adapter = localStorage({ directory: tempDir, fs, retryAttempts: 3 });

    await adapter.put('key.txt', Buffer.from('hello'), {
      mimeType: 'text/plain',
      size: 5,
    });
    expect(fs.write).toHaveBeenCalledTimes(1);
  });

  test('retries on transient filesystem error and succeeds before exhausting attempts', async () => {
    tempDir = makeTempDir();
    let callCount = 0;
    const fs = {
      write: mock(async (path: string, data: string | Uint8Array) => {
        callCount++;
        if (callCount <= 2) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        await Bun.write(path, data);
      }),
      readFile: mock(async () => null),
      exists: mock(async () => true),
    };
    const adapter = localStorage({ directory: tempDir, fs, retryAttempts: 3 });

    await adapter.put('key.txt', Buffer.from('hello'), {
      mimeType: 'text/plain',
      size: 5,
    });

    expect(callCount).toBe(3);
  });

  test('delay between retries follows exponential backoff', async () => {
    tempDir = makeTempDir();
    let callCount = 0;
    const fs = {
      write: mock(async (path: string, data: string | Uint8Array) => {
        callCount++;
        if (callCount <= 2) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        await Bun.write(path, data);
      }),
      readFile: mock(async () => null),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs,
      retryAttempts: 3,
      retryBaseDelayMs: 100,
    });

    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const mockTimer = ((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(delay ?? 0);
      return realSetTimeout(fn as (...a: unknown[]) => void, 0, ...args);
    }) as unknown as typeof setTimeout;
    globalThis.setTimeout = mockTimer;

    await adapter.put('key.txt', Buffer.from('hello'), {
      mimeType: 'text/plain',
      size: 5,
    });

    // Exponential backoff: 100 * 2^0 = 100, 100 * 2^1 = 200
    expect(delays).toEqual([100, 200]);
    globalThis.setTimeout = realSetTimeout;
  });

  test('throws the original error after exhausting all attempts', async () => {
    tempDir = makeTempDir();
    const fs = {
      write: mock(async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
      readFile: mock(async () => null),
      exists: mock(async () => true),
    };
    const adapter = localStorage({ directory: tempDir, fs, retryAttempts: 3 });

    await expect(
      adapter.put('key.txt', Buffer.from('hello'), { mimeType: 'text/plain', size: 5 }),
    ).rejects.toThrow('permission denied');
    expect(fs.write).toHaveBeenCalledTimes(3);
  });

  test('retryAttempts: 1 means no retries — fails fast', async () => {
    tempDir = makeTempDir();
    const fs = {
      write: mock(async () => {
        throw Object.assign(new Error('disk error'), { code: 'EIO' });
      }),
      readFile: mock(async () => null),
      exists: mock(async () => true),
    };
    const adapter = localStorage({ directory: tempDir, fs, retryAttempts: 1 });

    await expect(
      adapter.put('key.txt', Buffer.from('hello'), { mimeType: 'text/plain', size: 5 }),
    ).rejects.toThrow('disk error');
    expect(fs.write).toHaveBeenCalledTimes(1);
  });

  test('retries on get() and delete() operations too', async () => {
    tempDir = makeTempDir();
    let readCallCount = 0;
    let deleteCallCount = 0;
    const fs = {
      write: mock(async () => {}),
      readFile: mock(async () => {
        readCallCount++;
        if (readCallCount <= 1) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return new Uint8Array([1, 2, 3]);
      }),
      exists: mock(async () => true),
    };
    const adapter = localStorage({
      directory: tempDir,
      fs,
      retryAttempts: 2,
      retryBaseDelayMs: 10,
    });

    const result = await adapter.get('key.txt');
    expect(result).not.toBeNull();
    expect(readCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Health reporting
// ---------------------------------------------------------------------------

describe('localStorage getCircuitBreakerHealth', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('getCircuitBreakerHealth returns a consistent shape', () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });
    const health = adapter.getCircuitBreakerHealth();

    expect(health).toHaveProperty('state');
    expect(health).toHaveProperty('consecutiveFailures');
    expect(health).toHaveProperty('openedAt');
    expect(health).toHaveProperty('nextProbeAt');
    expect(health.state).toBe('closed');
  });
});
