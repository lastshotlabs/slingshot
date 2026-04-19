import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';
import type { CreateAppConfig } from '../src/app';
import { runPluginTeardown } from '../src/framework/runPluginLifecycle';
import { createServer, getServerContext } from '../src/server';
import type { CreateServerConfig } from '../src/server';
import { logTestBackend, resolveTestDbConfig } from './e2e/helpers/backend-factory';
import { createTestApp } from './setup';

// Re-export portable test utilities from the /testing subpath
export { createCookieJar } from '../src/testing';
export type { E2EServerHandle } from '../src/testing';

// Log resolved backend once at module load so CI output shows the active config
logTestBackend();

/**
 * HTTP-only E2E server.
 * Uses Bun.serve({ port: 0, fetch: app.fetch }) — same pattern as passkey-e2e.
 * Cannot be used for WS upgrade flows.
 */
export async function createTestHttpServer(
  overrides?: Partial<CreateAppConfig>,
  authOverrides?: any,
): Promise<import('../src/testing').E2EServerHandle> {
  const dbConfig = resolveTestDbConfig();
  const app = await createTestApp({ db: dbConfig, ...overrides }, authOverrides);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://localhost:${server.port}`;
  const wsUrl = `ws://localhost:${server.port}`;
  const ctx = getContext(app);
  const bus: SlingshotEventBus = ctx.bus;
  return {
    server: server as import('../src/testing').E2EServerHandle['server'],
    baseUrl,
    wsUrl,
    url: baseUrl,
    bus,
    stop: async () => {
      await runPluginTeardown([...ctx.plugins]);
      server.stop(true);
    },
    cleanup: async () => {
      await runPluginTeardown([...ctx.plugins]);
      server.stop(true);
    },
  };
}

/**
 * Full server — calls createServer(). Required for WS E2E, heartbeat, transport,
 * and any Bun.serve()-level behavior (error handler, upgrade routes, etc.).
 */
export async function createTestFullServer(
  config?: Partial<CreateServerConfig>,
): Promise<import('../src/testing').E2EServerHandle> {
  const dbConfig = resolveTestDbConfig();
  const fullConfig: CreateServerConfig = {
    routesDir: import.meta.dir + '/fixtures/routes',
    meta: { name: 'E2E Test App' },
    db: dbConfig,
    security: {
      rateLimit: { windowMs: 60_000, max: 1000 },
    },
    logging: { onLog: () => {} },
    port: 0,
    ...config,
  };
  const server = await createServer(fullConfig);
  const baseUrl = `http://localhost:${server.port}`;
  const wsUrl = `ws://localhost:${server.port}`;
  const ctx = getServerContext(server);
  const bus: SlingshotEventBus = ctx!.bus;
  return {
    server: server as import('../src/testing').E2EServerHandle['server'],
    baseUrl,
    wsUrl,
    url: baseUrl,
    bus,
    stop: () => server.stop(true),
    cleanup: async () => server.stop(true),
  };
}
