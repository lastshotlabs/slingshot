import { describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

// Verifies the runtime's graceful drain: a fetch handler that takes 2 s to
// finish must complete and return its body even if `stop({ timeoutMs })` is
// invoked mid-flight, provided the timeout is generous enough.
//
// This guards against a regression where stop() resolved on socket close
// rather than handler completion — under that bug a slow handler mid-write
// would have its socket ripped away and the client would see a truncated or
// reset response.

describe('runtime-node graceful drain', () => {
  test('slow handler completes when stop({ timeoutMs }) drains in-flight requests', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        return new Response('drained-ok');
      },
    });

    try {
      // Fire the slow request (do not await yet — we need to call stop() while
      // the handler is still running inside the server).
      const responsePromise = fetch(`http://127.0.0.1:${server.port}/slow`);

      // Give the request a beat to actually arrive at the handler.
      await new Promise(resolve => setTimeout(resolve, 100));

      // Begin a graceful drain with a 5 s budget — comfortably more than the
      // 2 s handler delay. Both promises should resolve cleanly.
      const stopPromise = (
        server as unknown as {
          stop: (opts: { timeoutMs: number }) => Promise<void>;
        }
      ).stop({ timeoutMs: 5_000 });

      const [response] = await Promise.all([responsePromise, stopPromise]);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('drained-ok');
    } catch (err) {
      // Ensure the server is torn down even if the assertions threw.
      await (server as unknown as { stop: (force: boolean) => Promise<void> })
        .stop(true)
        .catch(() => {});
      throw err;
    }
  }, 15_000);
});
