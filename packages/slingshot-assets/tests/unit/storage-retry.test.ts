import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

let sendCallCount = 0;
let sendShouldFailUntil = 0;
let capturedSendError: Error | null = null;

mock.module('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(_opts: Record<string, unknown>) {}
    async send(_command: unknown): Promise<{}> {
      sendCallCount++;
      if (sendCallCount <= sendShouldFailUntil) {
        throw capturedSendError ?? new Error('transient S3 error');
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

const { s3Storage } = await import('../../src/adapters/s3');
const { resolveStorageAdapter } = await import('../../src/adapters/index');

afterEach(() => {
  sendCallCount = 0;
  sendShouldFailUntil = 0;
  capturedSendError = null;
  mock.restore();
});

const fakeData = Buffer.from([1, 2, 3]);
const fakeMeta = { mimeType: 'application/octet-stream', size: 3 };

describe('withRetry — put()', () => {
  test('succeeds on first attempt when no error occurs', async () => {
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 3 });
    await adapter.put('key', fakeData, fakeMeta);
    expect(sendCallCount).toBe(1);
  });

  test('retries on transient failure and succeeds before exhausting attempts', async () => {
    sendShouldFailUntil = 2;
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 3 });

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await adapter.put('key', fakeData, fakeMeta);

    expect(sendCallCount).toBe(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  test('delay between retries follows attempt × 500 ms pattern', async () => {
    sendShouldFailUntil = 2;
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 3 });

    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(delay ?? 0);
      return realSetTimeout(fn as (...a: unknown[]) => void, 0, ...args);
    }) as unknown as typeof setTimeout);

    await adapter.put('key', fakeData, fakeMeta);

    expect(delays).toEqual([500, 1000]);
    spy.mockRestore();
  });

  test('throws the original error after exhausting all attempts', async () => {
    const err = new Error('permanent failure');
    capturedSendError = err;
    sendShouldFailUntil = Infinity;

    const adapter = s3Storage({ bucket: 'b', retryAttempts: 3 });

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await expect(adapter.put('key', fakeData, fakeMeta)).rejects.toThrow('permanent failure');
    expect(sendCallCount).toBe(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  test('retryAttempts: 1 means no retries — throws immediately on first failure', async () => {
    sendShouldFailUntil = Infinity;
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 1 });

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await expect(adapter.put('key', fakeData, fakeMeta)).rejects.toThrow();
    expect(sendCallCount).toBe(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe('withRetry — delete()', () => {
  test('retries on transient failure and succeeds before exhausting attempts', async () => {
    sendShouldFailUntil = 1;
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 3 });

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await adapter.delete('key');

    expect(sendCallCount).toBe(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting all attempts on delete()', async () => {
    sendShouldFailUntil = Infinity;
    const adapter = s3Storage({ bucket: 'b', retryAttempts: 2 });

    await expect(adapter.delete('key')).rejects.toThrow();
    expect(sendCallCount).toBe(2);
  });
});

describe('storageRetryAttempts config plumbing', () => {
  test('resolveStorageAdapter passes storageRetryAttempts to S3 adapter as retryAttempts', async () => {
    sendShouldFailUntil = Infinity;

    const adapter = resolveStorageAdapter(
      { adapter: 's3', config: { bucket: 'plumbing-bucket' } },
      { storageRetryAttempts: 1 },
    );

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await expect(adapter.put('key', fakeData, fakeMeta)).rejects.toThrow();

    expect(sendCallCount).toBe(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test('resolveStorageAdapter uses default retryAttempts (3) when storageRetryAttempts is omitted', async () => {
    sendShouldFailUntil = Infinity;

    const adapter = resolveStorageAdapter({ adapter: 's3', config: { bucket: 'default-bucket' } });

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    await expect(adapter.put('key', fakeData, fakeMeta)).rejects.toThrow();

    expect(sendCallCount).toBe(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
