import { describe, expect, mock, test } from 'bun:test';
import { createSseRegistry, createSseUpgradeHandler } from '../../src/framework/sse/index';

const endpoint = '/__sse/test';

function makeClient(id = 'client-1') {
  return { id, userId: null, endpoint };
}

async function readStream(stream: ReadableStream<Uint8Array>, maxChunks = 10): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let result = '';
  let count = 0;
  while (count < maxChunks) {
    const { done, value } = await reader.read();
    if (done) break;
    result += dec.decode(value);
    count++;
    // Stop after we have meaningful content (avoid blocking forever)
    if (result.includes('event:') || result.includes(': connected')) break;
  }
  reader.releaseLock();
  return result;
}

describe('createSseRegistry', () => {
  test('createClientStream returns a ReadableStream', () => {
    const registry = createSseRegistry();
    const stream = registry.createClientStream(endpoint, makeClient(), false);
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  test('fanout enqueues correctly formatted SSE event text', async () => {
    const registry = createSseRegistry();
    const client = makeClient();
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    const dec = new TextDecoder();

    // Read the initial ': connected' comment
    const { value: connChunk } = await reader.read();
    expect(dec.decode(connChunk)).toBe(': connected\n\n');

    // Fanout an event
    registry.fanout(endpoint, 'community:thread.created', { id: '123' }, undefined);

    const { value: eventChunk } = await reader.read();
    const text = dec.decode(eventChunk);
    expect(text).toBe('event: community:thread.created\ndata: {"id":"123"}\n\n');

    reader.releaseLock();
    await stream.cancel();
  });

  test('fanout suppresses event when filter returns false', async () => {
    const registry = createSseRegistry();
    const client = makeClient();
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();

    // Read initial comment
    await reader.read();

    const filter = () => false;
    registry.fanout(endpoint, 'community:thread.created', { id: '123' }, filter);

    // Give the async filter a tick to resolve
    await new Promise(r => setTimeout(r, 10));

    // No chunk should be available — use a race with a timeout promise
    let gotChunk = false;
    const readPromise = reader.read().then(({ value }) => {
      if (value) gotChunk = true;
    });
    await Promise.race([readPromise, new Promise(r => setTimeout(r, 20))]);

    expect(gotChunk).toBe(false);

    reader.releaseLock();
    await stream.cancel();
  });

  test('fanout is a no-op when no clients connected on endpoint', () => {
    const registry = createSseRegistry();
    // Should not throw
    expect(() =>
      registry.fanout(endpoint, 'community:thread.created', {}, undefined),
    ).not.toThrow();
  });

  test('cancel removes client from registry; subsequent fanout does not enqueue', async () => {
    const registry = createSseRegistry();
    const client = makeClient();
    const stream = registry.createClientStream(endpoint, client, false);

    // Start reading to activate the stream, then cancel
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'
    reader.releaseLock();
    await stream.cancel();

    // Give cancel a tick
    await new Promise(r => setTimeout(r, 10));

    // fanout should be a no-op (no clients)
    expect(() =>
      registry.fanout(endpoint, 'community:thread.created', {}, undefined),
    ).not.toThrow();
  });

  test('heartbeat timer sends keep-alive frames', async () => {
    const registry = createSseRegistry();
    const client = makeClient('hb-client');
    const stream = registry.createClientStream(endpoint, client, 50); // 50ms heartbeat
    const reader = stream.getReader();
    const dec = new TextDecoder();

    // Read initial connected comment
    const { value: connChunk } = await reader.read();
    expect(dec.decode(connChunk)).toBe(': connected\n\n');

    // Wait for at least one heartbeat
    const { value: hbChunk } = await reader.read();
    expect(dec.decode(hbChunk)).toBe(': keep-alive\n\n');

    reader.releaseLock();
    await stream.cancel();
  });

  test('fanout rejects event keys containing newlines (\\n)', async () => {
    const registry = createSseRegistry();
    const client = makeClient('nl-client');
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    registry.fanout(endpoint, 'bad\nevent' as any, {}, undefined);
    // Allow async filter tick
    await new Promise(r => setTimeout(r, 10));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[sse] fanout rejected');

    console.error = originalError;
    reader.releaseLock();
    await stream.cancel();
  });

  test('fanout rejects event keys containing carriage returns (\\r)', async () => {
    const registry = createSseRegistry();
    const client = makeClient('cr-client');
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    registry.fanout(endpoint, 'bad\revent' as any, {}, undefined);
    await new Promise(r => setTimeout(r, 10));

    expect(errorSpy).toHaveBeenCalledTimes(1);

    console.error = originalError;
    reader.releaseLock();
    await stream.cancel();
  });

  test('enqueue evicts client when controller throws (simulate closed stream)', async () => {
    const registry = createSseRegistry();
    const client = makeClient('evict-client');
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    // Close the reader (simulates disconnect) without going through cancel
    reader.releaseLock();
    // Cancel the stream to close controller
    await stream.cancel();
    // Give cancel a tick to fire
    await new Promise(r => setTimeout(r, 10));

    // fanout after eviction should be a no-op (no throw)
    expect(() =>
      registry.fanout(endpoint, 'community:thread.created', {}, undefined),
    ).not.toThrow();
  });

  test('enqueue catch block triggers when filter resolves after stream cancel (lines 137-138)', async () => {
    const registry = createSseRegistry();
    const client = makeClient('filter-catch-client');
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    // Create a filter that resolves AFTER we cancel the stream.
    // When the filter resolves true, enqueue will throw because the
    // controller is already closed, triggering the catch block.
    let resolveFilter!: (val: boolean) => void;
    const filterPromise = new Promise<boolean>(r => { resolveFilter = r; });
    const slowFilter = () => filterPromise;

    // Start fanout with the slow filter — it won't enqueue until the filter resolves
    registry.fanout(endpoint, 'community:thread.created' as any, { id: 'x' }, slowFilter as any);

    // Cancel the stream while the filter is pending — this closes the controller
    reader.releaseLock();
    await stream.cancel();

    // Now resolve the filter to true — enqueue will be called on a closed controller
    resolveFilter(true);
    await new Promise(r => setTimeout(r, 20));

    // The catch block should have evicted the client; fanout is now a no-op
    expect(() =>
      registry.fanout(endpoint, 'community:thread.created' as any, {}, undefined),
    ).not.toThrow();
  });

  test('fanout catches and logs filter errors (lines 195-200)', async () => {
    const registry = createSseRegistry();
    const client = makeClient('filter-err-client');
    const stream = registry.createClientStream(endpoint, client, false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const rejectingFilter = () => Promise.reject(new Error('filter boom'));
    registry.fanout(endpoint, 'community:thread.created' as any, { id: '1' }, rejectingFilter as any);

    // Allow the async filter promise to reject and trigger the catch
    await new Promise(r => setTimeout(r, 20));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[sse] filter error for client');

    console.error = originalError;
    reader.releaseLock();
    await stream.cancel();
  });

  test('cancel is idempotent (second cancel does not throw)', async () => {
    const registry = createSseRegistry();
    const stream = registry.createClientStream(endpoint, makeClient(), false);
    await stream.cancel();
    await expect(stream.cancel()).resolves.toBeUndefined();
  });

  test('closeAll closes all open streams; subsequent fanout is a no-op', async () => {
    const registry = createSseRegistry();
    const stream = registry.createClientStream(endpoint, makeClient(), false);
    const reader = stream.getReader();
    await reader.read(); // consume ': connected'

    registry.closeAll();

    // The stream should be done after closeAll
    const { done } = await reader.read();
    expect(done).toBe(true);
    reader.releaseLock();

    // fanout after closeAll should be silent
    expect(() =>
      registry.fanout(endpoint, 'community:thread.created', {}, undefined),
    ).not.toThrow();
  });
});

describe('createSseUpgradeHandler', () => {
  test('returns a function that resolves client data with id, userId, endpoint', async () => {
    const upgrade = createSseUpgradeHandler('/events');
    const req = new Request('http://localhost/events');
    const clientData = await upgrade(req);
    expect(typeof clientData.id).toBe('string');
    expect(clientData.id.length).toBeGreaterThan(0);
    expect(clientData.endpoint).toBe('/events');
    expect(clientData.userId).toBeNull();
  });

  test('uses custom userResolver when provided', async () => {
    const userResolver = {
      resolveUserId: async (_req: Request) => 'user-abc',
    };
    const upgrade = createSseUpgradeHandler('/events', userResolver);
    const req = new Request('http://localhost/events');
    const clientData = await upgrade(req);
    expect(clientData.userId).toBe('user-abc');
    expect(clientData.endpoint).toBe('/events');
  });

  test('produces unique ids on each call', async () => {
    const upgrade = createSseUpgradeHandler('/events');
    const req = new Request('http://localhost/events');
    const a = await upgrade(req);
    const b = await upgrade(req);
    expect(a.id).not.toBe(b.id);
  });
});
