import { afterEach, describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

/**
 * Graceful shutdown tests for the Node HTTP server.
 *
 * These verify the drain semantics of createNodeServer.stop():
 * - stop() waits for in-flight fetch handlers
 * - stop(true) force-closes immediately
 * - stop({ timeoutMs }) enforces an upper bound on drain time
 * - stop() is idempotent (safe to call multiple times)
 */

describe('runtime-node graceful shutdown', () => {
  let server: ReturnType<typeof nodeRuntime>['server'] extends {
    listen: (opts: unknown) => Promise<infer R>;
  }
    ? R
    : never;

  // We use a simpler server type since TS inference is tricky here
  let stop: (opts?: boolean | { timeoutMs?: number; closeActiveConnections?: boolean }) => Promise<void>;
  let port: number;

  afterEach(async () => {
    if (stop) {
      await stop(true).catch(() => {});
      stop = undefined as unknown as typeof stop;
    }
  });

  test('stop() resolves quickly on an idle server', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });
    stop = instance.stop.bind(instance);
    port = instance.port;

    expect(port).toBeGreaterThan(0);
    const start = Date.now();
    await stop();
    const elapsed = Date.now() - start;
    // Should resolve well under 1s for an idle server
    expect(elapsed).toBeLessThan(5_000);
  });

  test('stop(true) force-closes immediately even with active connections', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });
    stop = instance.stop.bind(instance);
    port = instance.port;

    // Establish a connection
    await fetch(`http://127.0.0.1:${port}/`);
    const start = Date.now();
    await stop(true);
    const elapsed = Date.now() - start;
    // Force close should resolve immediately
    expect(elapsed).toBeLessThan(2_000);
  });

  test('stop({ timeoutMs }) drains in-flight slow handlers', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        return new Response('drained');
      },
    });
    stop = instance.stop.bind(instance);

    // Fire a slow request (don't await yet)
    const responsePromise = fetch(`http://127.0.0.1:${instance.port}/slow`);
    // Give it a moment to reach the handler
    await new Promise(resolve => setTimeout(resolve, 50));

    // Stop with generous timeout — should wait for the handler
    const start = Date.now();
    await stop({ timeoutMs: 5_000 });
    const elapsed = Date.now() - start;

    // Should take at least the handler delay but less than the timeout
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(5_000);

    // The response should have completed successfully
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('drained');
    stop = undefined as unknown as typeof stop; // already stopped
  });

  test('stop({ timeoutMs }) with tight timeout force-closes before slow handler finishes', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        return new Response('too-late');
      },
    });
    stop = instance.stop.bind(instance);

    // Fire a very slow request
    const responsePromise = fetch(`http://127.0.0.1:${instance.port}/very-slow`);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Tight timeout — force close before the handler finishes
    const start = Date.now();
    await stop({ timeoutMs: 100 });
    const elapsed = Date.now() - start;

    // Should resolve near the timeout (not wait for the full 10s handler)
    expect(elapsed).toBeLessThan(2_000);

    // The response should either complete or be cut off
    try {
      const response = await responsePromise;
      // If it completed, it might be a partial response or error
      void response;
    } catch {
      // Or the connection was terminated — either is acceptable
    }
    stop = undefined as unknown as typeof stop;
  });

  test('multiple stop() calls are idempotent', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });
    stop = instance.stop.bind(instance);

    // Call stop twice
    await stop();
    await stop();
    // Second call should not throw
    stop = undefined as unknown as typeof stop;
  });

  test('stop(true) called twice is safe', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });
    stop = instance.stop.bind(instance);

    await stop(true);
    await stop(true);
    stop = undefined as unknown as typeof stop;
  });

  test('stop() with multiple concurrent in-flight requests drains all handlers', async () => {
    const runtime = nodeRuntime();
    let completed = 0;
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        completed += 1;
        return new Response('done');
      },
    });
    stop = instance.stop.bind(instance);

    // Fire 5 concurrent requests
    const requests = Array.from({ length: 5 }, () =>
      fetch(`http://127.0.0.1:${instance.port}/multi`),
    );

    // Give them time to reach the handler
    await new Promise(resolve => setTimeout(resolve, 50));

    // Stop with generous timeout
    await stop({ timeoutMs: 5_000 });

    // All responses should complete
    const responses = await Promise.allSettled(requests);
    const fulfilled = responses.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(5);
    for (const r of fulfilled) {
      const response = (r as PromiseFulfilledResult<Response>).value;
      expect(response.status).toBe(200);
    }

    // All handlers completed
    expect(completed).toBe(5);
    stop = undefined as unknown as typeof stop;
  });
});
