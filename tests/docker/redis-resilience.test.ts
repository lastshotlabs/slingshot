/**
 * Redis resilience tests.
 *
 * Verifies session behavior when Redis is flushed mid-operation (simulating
 * data loss / failover) and that the app handles the resulting cache miss
 * gracefully rather than crashing.
 *
 * Requires Docker Redis on port 6380 (docker-compose.test.yml).
 */
import {
  createRedisSessionRepository,
  createSession,
  getSession,
  getUserSessions,
} from '@auth/lib/session';
import type { SessionRepository } from '@auth/lib/session';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  connectTestRedis,
  disconnectTestServices,
  flushTestServices,
  getTestRedis,
} from '../setup-docker';

let repo: SessionRepository;

beforeAll(async () => {
  await connectTestRedis();
  repo = createRedisSessionRepository(() => getTestRedis(), 'resilience-test');
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

// ---------------------------------------------------------------------------
// Normal operation baseline
// ---------------------------------------------------------------------------

describe('Redis session — baseline', () => {
  it('creates and retrieves a session', async () => {
    await createSession(repo, 'user-r1', 'jwt-r1', 'sess-r1');
    expect(await getSession(repo, 'sess-r1')).toBe('jwt-r1');
  });
});

// ---------------------------------------------------------------------------
// Data loss simulation (Redis flush = all sessions lost)
// ---------------------------------------------------------------------------

describe('Redis resilience — data loss via flush', () => {
  it('session lookup returns null after Redis is flushed (no crash)', async () => {
    await createSession(repo, 'user-r2', 'jwt-r2', 'sess-r2');
    expect(await getSession(repo, 'sess-r2')).toBe('jwt-r2');

    // Simulate Redis restart / failover: all data is lost
    const redis = getTestRedis();
    await redis.flushdb();

    // getSession must return null, not throw
    const result = await getSession(repo, 'sess-r2');
    expect(result).toBeNull();
  });

  it('getUserSessions returns empty array after flush (not an error)', async () => {
    await createSession(repo, 'user-r3', 'jwt-r3', 'sess-r3');
    const redis = getTestRedis();
    await redis.flushdb();

    const sessions = await getUserSessions(repo, 'user-r3');
    expect(sessions).toBeInstanceOf(Array);
    expect(sessions.length).toBe(0);
  });

  it('new sessions can be created after data loss', async () => {
    const redis = getTestRedis();
    await redis.flushdb();

    // Should not throw even though prior state is gone
    await createSession(repo, 'user-r4', 'jwt-r4', 'sess-r4');
    expect(await getSession(repo, 'sess-r4')).toBe('jwt-r4');
  });
});

// ---------------------------------------------------------------------------
// Verify Redis is still healthy after tests
// ---------------------------------------------------------------------------

describe('Redis resilience — connection health after stress', () => {
  it('Redis client is still responsive after multiple flush cycles', async () => {
    const redis = getTestRedis();
    for (let i = 0; i < 3; i++) {
      await createSession(repo, `u${i}`, `jwt${i}`, `sess${i}`);
      await redis.flushdb();
    }
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });
});
