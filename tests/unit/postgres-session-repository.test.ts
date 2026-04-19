import { describe, expect, test } from 'bun:test';
import { createAuthResolvedConfig } from '../../packages/slingshot-auth/src/config/authConfig';
import { createPostgresSessionRepository } from '../../packages/slingshot-auth/src/lib/session/postgresStore';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function createMockPool() {
  const calls: QueryCall[] = [];
  let failSql: string | null = null;
  let failTimes = 0;
  let oldestSessionIds: string[] = [];

  const runQuery = async (sql: string, params?: unknown[]) => {
    const normalized = normalizeSql(sql);
    calls.push({ sql: normalized, params });

    if (failSql === normalized && failTimes > 0) {
      failTimes--;
      throw new Error(`forced failure: ${normalized}`);
    }

    if (normalized.includes('SELECT COUNT(*) AS count FROM auth_sessions')) {
      return { rows: [{ count: String(oldestSessionIds.length) }], rowCount: 1 };
    }

    if (normalized.includes('SELECT session_id FROM auth_sessions')) {
      const sessionId = oldestSessionIds.shift();
      return {
        rows: sessionId ? [{ session_id: sessionId }] : [],
        rowCount: sessionId ? 1 : 0,
      };
    }

    return { rows: [], rowCount: 1 };
  };

  const client = {
    query: runQuery,
    release() {},
  };

  return {
    pool: {
      query: runQuery,
      connect: async () => client,
    } as unknown as import('pg').Pool,
    calls,
    reset() {
      calls.length = 0;
      failSql = null;
      failTimes = 0;
      oldestSessionIds = [];
    },
    failOn(sql: string, times = 1) {
      failSql = normalizeSql(sql);
      failTimes = times;
    },
    setOldestSessions(sessionIds: string[]) {
      oldestSessionIds = [...sessionIds];
    },
  };
}

describe('createPostgresSessionRepository', () => {
  test('atomicCreateSession acquires an advisory lock before counting active sessions', async () => {
    const mock = createMockPool();
    const repo = createPostgresSessionRepository(mock.pool);
    const config = createAuthResolvedConfig({});

    await repo.createSession('warm-user', 'warm-token', 'warm-session', undefined, config);
    mock.reset();

    await repo.atomicCreateSession('user-a', 'token-1', 'sess-1', 3, undefined, config);
    await repo.atomicCreateSession('user-a', 'token-2', 'sess-2', 3, undefined, config);
    await repo.atomicCreateSession('user-b', 'token-3', 'sess-3', 3, undefined, config);

    const lockCalls = mock.calls.filter(
      call => call.sql === 'SELECT pg_advisory_xact_lock($1::bigint)',
    );
    expect(lockCalls).toHaveLength(3);
    expect(lockCalls[0].params).toHaveLength(1);
    expect(lockCalls[0].params?.[0]).toBe(lockCalls[1].params?.[0]);
    expect(lockCalls[0].params?.[0]).not.toBe(lockCalls[2].params?.[0]);

    const firstLockIndex = mock.calls.findIndex(
      call => call.sql === 'SELECT pg_advisory_xact_lock($1::bigint)',
    );
    const firstCountIndex = mock.calls.findIndex(call =>
      call.sql.includes('SELECT COUNT(*) AS count FROM auth_sessions'),
    );
    expect(firstLockIndex).toBeGreaterThan(-1);
    expect(firstCountIndex).toBeGreaterThan(firstLockIndex);
  });

  test('atomicCreateSession rolls back when a locked transaction step fails', async () => {
    const mock = createMockPool();
    const repo = createPostgresSessionRepository(mock.pool);
    const config = createAuthResolvedConfig({});

    await repo.createSession('warm-user', 'warm-token', 'warm-session', undefined, config);
    mock.reset();

    mock.failOn(
      `SELECT COUNT(*) AS count FROM auth_sessions
       WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2`,
    );

    await expect(
      repo.atomicCreateSession('user-a', 'token-1', 'sess-1', 3, undefined, config),
    ).rejects.toThrow('forced failure');

    expect(mock.calls.map(call => call.sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2',
      'ROLLBACK',
    ]);
  });

  test('atomicCreateSession evicts inside the same locked transaction when over capacity', async () => {
    const mock = createMockPool();
    const repo = createPostgresSessionRepository(mock.pool);
    const config = createAuthResolvedConfig({ persistSessionMetadata: false });

    await repo.createSession('warm-user', 'warm-token', 'warm-session', undefined, config);
    mock.reset();
    mock.setOldestSessions(['oldest-session']);

    await repo.atomicCreateSession('user-a', 'token-1', 'sess-1', 1, undefined, config);

    expect(mock.calls.map(call => call.sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2',
      'SELECT session_id FROM auth_sessions WHERE user_id = $1 AND token IS NOT NULL AND expires_at > $2 ORDER BY created_at ASC LIMIT 1',
      'DELETE FROM auth_sessions WHERE session_id = $1',
      'INSERT INTO auth_sessions (session_id, user_id, token, created_at, last_active_at, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (session_id) DO NOTHING',
      'COMMIT',
    ]);
  });
});
