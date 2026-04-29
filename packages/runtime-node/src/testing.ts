// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-runtime-node/testing — Test utilities
// ---------------------------------------------------------------------------
import type {
  RuntimeServerInstance,
  RuntimeWebSocketHandler,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from './index';

export { runtimeNodeInternals } from './index';

/**
 * Handle returned by {@link createTestServer}.
 */
export interface TestServerHandle {
  /** The underlying {@link RuntimeServerInstance}. */
  server: RuntimeServerInstance;
  /** The {@link SlingshotRuntime} that created the server. */
  runtime: SlingshotRuntime;
  /** The port the server is listening on (OS-assigned when port=0). */
  port: number;
  /** Shorthand for `server.stop(true)`. */
  stop: () => Promise<void>;
}

/**
 * Options for {@link createTestServer}.
 */
export interface TestServerOptions {
  hostname?: string;
  websocket?: RuntimeWebSocketHandler;
  error?: (err: Error) => Response;
  maxRequestBodySize?: number;
}

/**
 * Create a real Node HTTP test server on an ephemeral port.
 *
 * The server listens on `127.0.0.1` (or the provided hostname) and is safe
 * to use concurrently in test suites — each call returns a fresh port.
 *
 * @example
 * ```ts
 * import { createTestServer } from '@lastshotlabs/slingshot-runtime-node/testing';
 *
 * const { port, stop } = await createTestServer(req => new Response('ok'));
 * const res = await fetch(`http://127.0.0.1:${port}/`);
 * expect(await res.text()).toBe('ok');
 * await stop();
 * ```
 */
export async function createTestServer(
  fetchFn: (req: Request) => Response | Promise<Response>,
  opts?: TestServerOptions,
): Promise<TestServerHandle> {
  const runtime = nodeRuntime();
  const server = await runtime.server.listen({
    port: 0,
    hostname: opts?.hostname ?? '127.0.0.1',
    fetch: fetchFn,
    ...(opts?.websocket ? { websocket: opts.websocket } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
    ...(opts?.maxRequestBodySize !== undefined
      ? { maxRequestBodySize: opts.maxRequestBodySize }
      : {}),
  });
  return {
    server,
    runtime,
    port: server.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
