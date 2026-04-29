/**
 * Edge-case tests for Lambda streaming: response streaming, error during
 * stream, stream cancellation, and streaming handler wrapping with various
 * payload types.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Streaming-handler tests intentionally avoid mocking bootstrap to prevent
// module-level mock leakage. See streaming.test.ts for details.
// ---------------------------------------------------------------------------

// Save/restore the awslambda global
const originalAwslambda = (globalThis as { awslambda?: unknown }).awslambda;

function installStreamifyShim(): {
  streamifyResponse: ReturnType<typeof mock>;
} {
  const streamifyResponse = mock((handler: (...args: unknown[]) => unknown) => {
    const wrapped = async (event: unknown, context: unknown) => {
      const chunks: Array<string | Uint8Array> = [];
      const responseStream = {
        write(chunk: string | Uint8Array) {
          chunks.push(chunk);
          return true;
        },
        end(chunk?: string | Uint8Array) {
          if (chunk !== undefined) chunks.push(chunk);
        },
      };
      await handler(event, responseStream, context);
      return chunks;
    };
    (wrapped as unknown as { __streamified: boolean }).__streamified = true;
    return wrapped;
  });
  (globalThis as { awslambda?: unknown }).awslambda = { streamifyResponse };
  return { streamifyResponse };
}

function uninstallStreamifyShim(): void {
  if (originalAwslambda === undefined) {
    delete (globalThis as { awslambda?: unknown }).awslambda;
  } else {
    (globalThis as { awslambda?: unknown }).awslambda = originalAwslambda;
  }
}

describe('streaming edge cases', () => {
  afterEach(() => {
    uninstallStreamifyShim();
  });

  test('streams large JSON payload without truncation', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const largeArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      value: `item-${i}-${'x'.repeat(50)}`,
    }));
    const wrapped = wrapStreamingHandler(
      (async () => ({ items: largeArray, total: largeArray.length })) as never,
    );
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    const joined = chunks.join('');
    const parsed = JSON.parse(joined);
    expect(parsed.total).toBe(1000);
    expect(parsed.items).toHaveLength(1000);
  });

  test('streams Buffer payload as-is', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const wrapped = wrapStreamingHandler((async () => buf) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    expect(chunks.some(c => Buffer.isBuffer(c) && c.equals(buf))).toBe(true);
  });

  test('error during stream writes error JSON to the stream', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const wrapped = wrapStreamingHandler((async () => {
      throw new Error('stream-error-during-handler');
    }) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    const joined = chunks.join('');
    expect(joined).toContain('streaming-handler-failed');
    expect(joined).toContain('stream-error-during-handler');
  });

  test('non-streaming handler (no awslambda) returns handler unchanged', async () => {
    uninstallStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const handler = async () => 'plain';
    const wrapped = wrapStreamingHandler(handler as never);
    expect(wrapped).toBe(handler);
  });

  test('streaming writes string payloads', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const wrapped = wrapStreamingHandler((async () => 'raw-string-output') as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    expect(chunks.join('')).toBe('raw-string-output');
  });

  test('streaming with binary Buffer end chunk', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const wrapped = wrapStreamingHandler((async () => Buffer.from([0xde, 0xad])) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    const found = chunks.filter(c => Buffer.isBuffer(c));
    expect(found.length).toBeGreaterThan(0);
  });

  test('streaming handler that returns null ends the stream gracefully', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const wrapped = wrapStreamingHandler((async () => null) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    // null payload invokes end() without a chunk — 0 chunks is expected
    expect(chunks).toHaveLength(0);
  });
});
