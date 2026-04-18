// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot/testing — Test utilities separated from production API
//
// This is permanent testing infrastructure, not a transitional bridge.
// Maintained alongside production exports for the lifetime of the package.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// E2E test helpers — reusable by consumers writing integration tests
// ---------------------------------------------------------------------------
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';
import type { CreateServerConfig } from './server';
import { createServer, getServerContext } from './server';

export { resetMetrics } from '@framework/metrics/registry';

export interface E2EServerHandle {
  server: { port: number; stop(close?: boolean): void | Promise<void> };
  baseUrl: string;
  wsUrl: string;
  url: string;
  bus: SlingshotEventBus;
  stop(): void | Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Create an E2EServerHandle from a pre-built Hono app.
 * HTTP-only — cannot be used for WS upgrade flows.
 */
export async function wrapAppAsTestServer(app: {
  fetch: (...args: unknown[]) => unknown;
}): Promise<E2EServerHandle> {
  const { bunRuntime } = await import('@slingshot/runtime-bun');
  const rt = bunRuntime();
  const server = await rt.server.listen({
    port: 0,
    fetch: app.fetch as (req: Request) => Response | Promise<Response>,
  });
  const baseUrl = `http://localhost:${server.port}`;
  const wsUrl = `ws://localhost:${server.port}`;
  const ctx = getContext(app);
  const bus: SlingshotEventBus = ctx.bus;
  return {
    server,
    baseUrl,
    wsUrl,
    url: baseUrl,
    bus,
    stop: () => server.stop(true),
    cleanup: async () => server.stop(true),
  };
}

/**
 * Full test server — calls createServer(). Required for WS E2E, heartbeat,
 * transport, and any Bun.serve()-level behavior.
 */
export async function createTestFullServer(
  config?: Partial<CreateServerConfig>,
): Promise<E2EServerHandle> {
  const fullConfig: CreateServerConfig = {
    routesDir: '.',
    meta: { name: 'E2E Test App' },
    db: {
      mongo: false,
      redis: false,
      sessions: 'memory',
      cache: 'memory',
      auth: 'memory',
    },
    security: {
      rateLimit: { windowMs: 60_000, max: 1000 },
    },
    logging: { onLog: () => {} },
    port: 0,
    ...config,
  };
  const previousPort = process.env.PORT;
  process.env.PORT = String(fullConfig.port ?? 0);
  let bunServer;
  try {
    bunServer = await createServer(fullConfig);
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
  }
  const server: E2EServerHandle['server'] = bunServer as unknown as E2EServerHandle['server'];
  const baseUrl = `http://localhost:${bunServer.port}`;
  const wsUrl = `ws://localhost:${bunServer.port}`;
  const ctx = getServerContext(bunServer);
  if (!ctx) throw new Error('[slingshot] createTestFullServer: context not found on server');
  const bus: SlingshotEventBus = ctx.bus;
  return {
    server,
    baseUrl,
    wsUrl,
    url: baseUrl,
    bus,
    stop: () => bunServer.stop(true),
    cleanup: async () => bunServer.stop(true),
  };
}

/**
 * Lightweight cookie jar for E2E tests.
 * fetch() doesn't auto-handle Set-Cookie — this helper accumulates
 * Set-Cookie headers and injects Cookie on subsequent requests.
 */
export function createCookieJar() {
  const cookies: Map<string, string> = new Map();

  function absorb(response: Response) {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) return;
    const parts = setCookie.split(/,(?=[^ ])/);
    for (const part of parts) {
      const [kv] = part.trim().split(';');
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      cookies.set(name, value);
    }
  }

  function header(): Record<string, string> {
    if (cookies.size === 0) return {};
    const value = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return { cookie: value };
  }

  function clear() {
    cookies.clear();
  }

  return { absorb, header, clear };
}
