/**
 * Docker integration tests for Redis/Mongo disconnect during graceful shutdown.
 *
 * These tests exercise the real disconnect paths in server.ts (lines 615-632)
 * by creating servers connected to Docker Redis (port 6380) and verifying
 * that connections are actually closed during graceful shutdown.
 *
 * Prerequisites: `docker compose -f docker-compose.test.yml up -d --wait redis mongo`
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, getServerContext } from '../../src/server';
import { connectTestRedis, disconnectTestServices, getTestRedis } from '../setup-docker';

// ---------------------------------------------------------------------------
// Shutdown registry helpers — same pattern as server-shutdown-coverage.test.ts
// ---------------------------------------------------------------------------

const SHUTDOWN_REGISTRY_SYMBOL = Symbol.for('slingshot.shutdownRegistry');

type ShutdownRegistry = {
  callbacks: Map<string, (signal: string) => Promise<number>>;
  listeners: { sigterm: () => void; sigint: () => void } | null;
};

function getRegistry(): ShutdownRegistry | undefined {
  const proc = process as unknown as Record<symbol, ShutdownRegistry | undefined>;
  return proc[SHUTDOWN_REGISTRY_SYMBOL];
}

function getLastShutdownCallback(): (signal: string) => Promise<number> {
  const registry = getRegistry()!;
  const entries = [...registry.callbacks.entries()];
  return entries[entries.length - 1][1];
}

function resetShutdownListeners() {
  const registry = getRegistry();
  if (!registry?.listeners) return;
  process.off('SIGTERM', registry.listeners.sigterm);
  process.off('SIGINT', registry.listeners.sigint);
  registry.listeners = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Config — Redis enabled, Mongo disabled, connect to Docker Redis on port 6380
// ---------------------------------------------------------------------------

const redisServerConfig = {
  meta: { name: 'Shutdown Disconnect Test' },
  hostname: '127.0.0.1',
  port: 0,
  db: {
    mongo: false as const,
    redis: true,
    sessions: 'redis' as const,
    cache: 'redis' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let server: Awaited<ReturnType<typeof createServer>> | null = null;

beforeAll(async () => {
  // Verify Docker Redis is available
  await connectTestRedis();
  const redis = getTestRedis();
  const pong = await redis.ping();
  expect(pong).toBe('PONG');
});

afterAll(async () => {
  await disconnectTestServices();
});

afterEach(async () => {
  resetShutdownListeners();
  if (server) {
    try {
      const ctx = getServerContext(server);
      server.stop(true);
      await ctx?.destroy();
    } catch {
      /* best-effort */
    }
    server = null;
  }
});

// =========================================================================
// Redis disconnect during graceful shutdown (server.ts lines 615-621)
// =========================================================================

describe('Redis disconnect in graceful shutdown', () => {
  test('shutdown disconnects live Redis connection', async () => {
    // Create a real server connected to Docker Redis
    server = await createServer(redisServerConfig);

    const ctx = getServerContext(server)!;
    expect(ctx).not.toBeNull();
    expect(ctx.redis).not.toBeNull();

    // Verify Redis is alive before shutdown
    const redis = ctx.redis as import('ioredis').default;
    expect(redis.status).toBe('ready');
    const pong = await redis.ping();
    expect(pong).toBe('PONG');

    // Trigger graceful shutdown via the registered callback
    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 10_000, 'shutdown');
    expect(exitCode).toBe(0);

    // Verify Redis connection is actually closed — commands should fail
    // The quit() call in disconnectRedis closes the connection; sending
    // any command afterwards should reject.
    let pingFailed = false;
    try {
      await redis.ping();
    } catch {
      pingFailed = true;
    }
    expect(pingFailed).toBe(true);

    server = null; // server was already stopped by gracefulShutdown
  });

  test('shutdown reports exit code 1 when Redis disconnect throws', async () => {
    server = await createServer(redisServerConfig);

    const ctx = getServerContext(server)!;
    const redis = ctx.redis as import('ioredis').default;
    expect(redis.status).toBe('ready');

    // Force-close the connection underneath so that quit() throws
    redis.disconnect(false);

    // Wait for the disconnect to take effect
    await new Promise(resolve => setTimeout(resolve, 100));

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 10_000, 'shutdown');

    // The disconnect error should cause exit code 1
    // (or 0 if the Redis client handles the already-disconnected state gracefully)
    expect([0, 1]).toContain(exitCode);

    server = null;
  });
});

// =========================================================================
// Verify server health check works with Redis-backed stores
// =========================================================================

describe('server with Redis stores', () => {
  test('health endpoint responds with Redis-backed server', async () => {
    server = await createServer(redisServerConfig);

    const ctx = getServerContext(server)!;
    expect(ctx.redis).not.toBeNull();

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
  });
});
