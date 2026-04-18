import { describe, expect, mock, test } from 'bun:test';
import { createSseRegistry } from '../../src/framework/sse/index';

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
