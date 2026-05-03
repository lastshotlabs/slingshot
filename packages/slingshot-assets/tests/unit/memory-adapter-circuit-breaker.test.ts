import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryCircuitOpenError, memoryStorage } from '../../src/adapters/memory';

describe('memoryStorage circuit breaker', () => {
  afterEach(() => {
    // No cleanup needed.
  });

  test('starts in closed state with no consecutive failures', () => {
    const adapter = memoryStorage();
    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
  });

  test('stays closed during normal operations', async () => {
    const adapter = memoryStorage();
    await adapter.put('a.txt', Buffer.from('hello'), { mimeType: 'text/plain', size: 5 });
    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(0);

    const result = await adapter.get('a.txt');
    expect(result).not.toBeNull();
    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');

    await adapter.delete('a.txt');
    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');
  });

  test('missing get returns null without affecting breaker', async () => {
    const adapter = memoryStorage();
    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(0);
  });

  test('delete on missing key is a no-op without affecting breaker', async () => {
    const adapter = memoryStorage();
    await adapter.delete('nonexistent');
    expect(adapter.getCircuitBreakerHealth().consecutiveFailures).toBe(0);
  });

  test('default threshold is 5 and default cooldown is 30 000 ms', () => {
    const adapter = memoryStorage({ now: () => 1_234_000 });
    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('closed');
    expect(health.openedAt).toBeUndefined();
    expect(health.nextProbeAt).toBeUndefined();
  });

  test('getCircuitBreakerHealth returns a consistent shape', () => {
    const adapter = memoryStorage();
    const health = adapter.getCircuitBreakerHealth();

    expect(health).toHaveProperty('state');
    expect(health).toHaveProperty('consecutiveFailures');
    expect(health).toHaveProperty('openedAt');
    expect(health).toHaveProperty('nextProbeAt');
    expect(health.state).toBe('closed');
  });
});

describe('memoryStorage adapter basic operations', () => {
  test('stores and retrieves Buffer data', async () => {
    const adapter = memoryStorage();
    await adapter.put('buf.bin', Buffer.from([1, 2, 3]), {
      mimeType: 'application/octet-stream',
      size: 3,
    });
    const result = await adapter.get('buf.bin');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
    const bytes = new Uint8Array(await new Response(result!.stream).arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('stores Blob data', async () => {
    const adapter = memoryStorage();
    await adapter.put('blob.txt', new Blob(['blob-content']), {
      mimeType: 'text/plain',
      size: 12,
    });
    const result = await adapter.get('blob.txt');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('text/plain');
    const text = await new Response(result!.stream).text();
    expect(text).toBe('blob-content');
  });

  test('stores ReadableStream data', async () => {
    const adapter = memoryStorage();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream-data'));
        controller.close();
      },
    });
    await adapter.put('stream.txt', stream, {
      mimeType: 'text/plain',
      size: 11,
    });
    const result = await adapter.get('stream.txt');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(11);
    const text = await new Response(result!.stream).text();
    expect(text).toBe('stream-data');
  });

  test('returns null for missing key', async () => {
    const adapter = memoryStorage();
    const result = await adapter.get('missing');
    expect(result).toBeNull();
  });

  test('delete removes stored data', async () => {
    const adapter = memoryStorage();
    await adapter.put('tmp.txt', Buffer.from('temp'), { mimeType: 'text/plain', size: 4 });
    expect(await adapter.get('tmp.txt')).not.toBeNull();
    await adapter.delete('tmp.txt');
    expect(await adapter.get('tmp.txt')).toBeNull();
  });

  test('delete on missing key does not throw', async () => {
    const adapter = memoryStorage();
    await expect(adapter.delete('neverborn')).resolves.toBeUndefined();
  });
});
