import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotHandler } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Streaming-handler tests intentionally avoid mocking `../src/bootstrap` so
// they don't leak a module-level mock into other tests in the same Bun
// process (notably `bootstrap.test.ts`). All assertions here either inspect
// the wrapper *factory* output before any invocation, or hit
// `wrapStreamingHandler` directly without going through `createLambdaRuntime`.
// ---------------------------------------------------------------------------

function createHandler(impl: () => Promise<unknown>): SlingshotHandler {
  return {
    name: 'streaming.test',
    input: z.any(),
    output: z.any(),
    guards: [],
    after: [],
    async invoke() {
      return impl();
    },
  };
}

// Track and restore the original `awslambda` global between tests so installing
// a mock shim never leaks into other test files.
const originalAwslambda = (globalThis as { awslambda?: unknown }).awslambda;

function installStreamifyShim(): {
  streamifyResponse: ReturnType<typeof mock>;
} {
  const streamifyResponse = mock((handler: (...args: unknown[]) => unknown) => {
    // Return a marker function so callers can verify the handler went through
    // streamifyResponse vs being returned unchanged.
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

describe('lambda streaming feature detection', () => {
  afterEach(() => {
    uninstallStreamifyShim();
  });

  test('isStreamingSupported reflects awslambda global presence', async () => {
    uninstallStreamifyShim();
    const { isStreamingSupported } = await import('../src/streaming');
    expect(isStreamingSupported()).toBe(false);

    installStreamifyShim();
    expect(isStreamingSupported()).toBe(true);
  });

  test('wrapStreamingHandler returns the original handler when shim is missing', async () => {
    uninstallStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');
    const orig = async () => 'unchanged';
    const wrapped = wrapStreamingHandler(orig as never);
    // Identity check — fallback path returns the same function.
    expect(wrapped).toBe(orig);
  });

  test('wrapStreamingHandler delegates to awslambda.streamifyResponse when present', async () => {
    const { streamifyResponse } = installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');

    const inner = async () => ({ ok: true, n: 7 });
    const wrapped = wrapStreamingHandler(inner as never);

    expect(streamifyResponse).toHaveBeenCalledTimes(1);
    expect((wrapped as unknown as { __streamified?: boolean }).__streamified).toBe(true);

    // Drive the wrapped handler — the mock streamifyResponse hands the inner
    // streaming function a synthetic responseStream and returns the chunks
    // collected from .write/.end.
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('"ok":true');
  });

  test('wrapStreamingHandler writes string payloads verbatim', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');
    const wrapped = wrapStreamingHandler((async () => 'hello-world') as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    expect(chunks).toContain('hello-world');
  });

  test('wrapStreamingHandler writes Buffer payloads as-is', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');
    const buf = Buffer.from([1, 2, 3]);
    const wrapped = wrapStreamingHandler((async () => buf) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    expect(chunks.some(c => Buffer.isBuffer(c) && c.equals(buf))).toBe(true);
  });

  test('wrapStreamingHandler writes a structured error when handler throws', async () => {
    installStreamifyShim();
    const { wrapStreamingHandler } = await import('../src/streaming');
    const wrapped = wrapStreamingHandler((async () => {
      throw new Error('boom');
    }) as never);
    const chunks = (await wrapped({}, {})) as Array<string | Uint8Array>;
    const joined = chunks.join('');
    expect(joined).toContain('streaming-handler-failed');
    expect(joined).toContain('boom');
  });
});

describe('createLambdaRuntime streaming option', () => {
  afterEach(() => {
    uninstallStreamifyShim();
  });

  test('streamingHandler:true wraps the handler when awslambda.streamifyResponse exists', async () => {
    const { streamifyResponse } = installStreamifyShim();
    const { createLambdaRuntime } = await import('../src/runtime');

    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      streamingHandler: true,
    });
    const wrapped = runtime.wrap(
      createHandler(async () => ({ ok: true })),
      'schedule',
    );

    // The wrap factory is synchronous and runs before any bootstrap. We just
    // need to verify that the streamifyResponse shim was invoked exactly once,
    // proving the runtime opted into streaming.
    expect(streamifyResponse).toHaveBeenCalledTimes(1);
    expect((wrapped as unknown as { __streamified?: boolean }).__streamified).toBe(true);
  });

  test('streamingHandler:true falls back gracefully when awslambda is absent', async () => {
    uninstallStreamifyShim();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { createLambdaRuntime } = await import('../src/runtime');
      createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        streamingHandler: true,
      });
      expect(
        warnSpy.mock.calls.some((args: unknown[]) =>
          String(args[0] ?? '').includes('streamingHandler:true requested'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('streamingHandler:false does not call streamifyResponse even when shim exists', async () => {
    const { streamifyResponse } = installStreamifyShim();
    const { createLambdaRuntime } = await import('../src/runtime');

    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });
    runtime.wrap(
      createHandler(async () => ({ ok: true })),
      'schedule',
    );

    expect(streamifyResponse).not.toHaveBeenCalled();
  });
});
