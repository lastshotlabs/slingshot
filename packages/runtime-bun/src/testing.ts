// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-runtime-bun/testing — Test utilities
// ---------------------------------------------------------------------------
import type {
  RuntimeServerInstance,
  RuntimeWebSocketHandler,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';
import { bunRuntime } from './index';

export { resetProcessSafetyNetForTest } from './index';

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
 * Create a real Bun.serve-based test server on an ephemeral port.
 *
 * The server listens on `127.0.0.1` (or the provided hostname) with
 * `installProcessSafetyNet: false` so that it is safe to use in test suites
 * that register their own process handlers.
 *
 * @example
 * ```ts
 * import { createTestServer } from '@lastshotlabs/slingshot-runtime-bun/testing';
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
  const runtime = bunRuntime({ installProcessSafetyNet: false });
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
