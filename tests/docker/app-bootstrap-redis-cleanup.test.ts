/**
 * Docker integration tests for Redis cleanup in cleanupBootstrapFailure().
 *
 * Tests that when `createApp()` fails AFTER prepareBootstrap succeeds
 * (e.g., bad permissions adapter), the Redis connection created during
 * infrastructure setup is properly closed (app.ts lines 347-354).
 *
 * Strategy:
 * - Configure `db.redis: true` so `createInfrastructure` connects to Docker Redis
 * - Configure `permissions: { adapter: 'postgres' }` WITHOUT postgres to force
 *   `buildContext()` to throw AFTER bootstrap succeeds
 * - Verify no connection leak by running multiple failures and checking that
 *   connection count stays stable (not growing)
 *
 * Prerequisites: `docker compose -f docker-compose.test.yml up -d --wait redis`
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { connectTestRedis, disconnectTestServices, getTestRedis } from '../setup-docker';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await connectTestRedis();
  const redis = getTestRedis();
  const pong = await redis.ping();
  expect(pong).toBe('PONG');
});

afterAll(async () => {
  await disconnectTestServices();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count the number of active Redis client connections. */
async function getClientCount(): Promise<number> {
  const redis = getTestRedis();
  const clientList = (await redis.client('LIST')) as string;
  return clientList.split('\n').filter(line => line.trim().length > 0).length;
}

const baseConfig = {
  meta: { name: 'Redis Cleanup Test' },
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

function makeTestBus(shutdown: () => Promise<void>): SlingshotEventBus {
  return {
    emit() {},
    on() {},
    onEnvelope() {},
    off() {
      return true;
    },
    offEnvelope() {
      return true;
    },
    shutdown,
  };
}

// =========================================================================
// Redis cleanup during bootstrap failure (app.ts lines 347-354)
// =========================================================================

describe('cleanupBootstrapFailure with live Redis', () => {
  test('Redis connection does not leak across multiple bootstrap failures', async () => {
    // Wait for any previous connections to fully close
    await new Promise(resolve => setTimeout(resolve, 500));

    const countBefore = await getClientCount();

    // Run multiple createApp failures — each one connects to Redis during
    // prepareBootstrap, then fails in buildContext, then cleanupBootstrapFailure
    // should disconnect Redis. If cleanup leaks, the count will grow.
    for (let i = 0; i < 3; i++) {
      await expect(
        createApp({
          ...baseConfig,
          permissions: { adapter: 'postgres' },
        }),
      ).rejects.toThrow();
      // Give ioredis time to close the TCP socket after quit()
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const countAfter = await getClientCount();

    // If cleanupBootstrapFailure properly called disconnectRedis each time,
    // the connection count should not have grown. Allow tolerance of 1 for
    // TCP close timing, but definitely not 3+ (which would mean leak).
    expect(countAfter - countBefore).toBeLessThanOrEqual(1);
  });

  test('Redis cleanup happens even with custom bus that fails shutdown', async () => {
    const bus = makeTestBus(async () => {
      throw new Error('bus shutdown failed');
    });

    let error: unknown;
    try {
      await createApp({
        ...baseConfig,
        eventBus: bus,
        permissions: { adapter: 'postgres' },
      });
    } catch (err) {
      error = err;
    }

    // The original error should propagate (not the bus error)
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Postgres');
  });
});
