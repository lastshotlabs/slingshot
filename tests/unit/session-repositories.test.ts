import { createAuthResolvedConfig } from '@auth/config/authConfig';
import {
  type SessionRepository,
  createMemorySessionRepository,
  createRedisSessionRepository,
  createSession,
  createSqliteSessionRepository,
  getSession,
  getSessionByRefreshToken,
  rotateRefreshToken,
  setRefreshToken,
} from '@auth/lib/session';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_ENTRIES } from '@lastshotlabs/slingshot-core';

const ONE_HOUR_MS = 60 * 60 * 1000;

class FakeRedis {
  private readonly strings = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  private pruneExpired(key: string): void {
    const entry = this.strings.get(key);
    if (entry != null && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
    }
  }

  private writePreservingTtl(key: string, value: string, persist: boolean): void {
    this.pruneExpired(key);
    const existing = this.strings.get(key);
    const expiresAt = !persist ? (existing?.expiresAt ?? null) : null;
    this.strings.set(key, { value, expiresAt });
  }

  async get(key: string): Promise<string | null> {
    this.pruneExpired(key);
    return this.strings.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    let expiresAt: number | null = null;
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1] * 1000;
    }
    if (args[0] === 'PX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1];
    }
    this.strings.set(key, { value, expiresAt });
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    return this.set(key, value, 'EX', seconds);
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      this.pruneExpired(key);
      if (this.strings.delete(key)) deleted++;
    }
    return deleted;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.pruneExpired(key);
    const entry = this.strings.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replaceAll('*', '.*')}$`);
    return [...this.strings.keys()].filter(key => {
      this.pruneExpired(key);
      return this.strings.has(key) && regex.test(key);
    });
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let set = this.sortedSets.get(key);
    if (!set) {
      set = new Map<string, number>();
      this.sortedSets.set(key, set);
    }
    set.set(member, score);
    return 1;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    const members = [...set.entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member);
    const end = stop === -1 ? members.length : stop + 1;
    return members.slice(start, end);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map(key => this.get(key)));
  }

  async eval(script: string, _numkeys: number, ...args: unknown[]): Promise<unknown> {
    if (script.includes('local field = ARGV[1]')) {
      const key = String(args[0]);
      const field = String(args[1]);
      const value = args[2];
      const valueType = String(args[3]);
      const persist = String(args[4]) === '1';
      const raw = await this.get(key);
      if (!raw) return 0;
      const rec = JSON.parse(raw) as Record<string, unknown>;
      rec[field] = valueType === 'number' ? Number(value) : value;
      this.writePreservingTtl(key, JSON.stringify(rec), persist);
      return 1;
    }

    if (script.includes('local rawJson = ARGV[1]')) {
      const key = String(args[0]);
      const rawJson = String(args[1]);
      const persist = String(args[2]) === '1';
      this.writePreservingTtl(key, rawJson, persist);
      return 1;
    }

    throw new Error('FakeRedis.eval received unsupported script');
  }

  async lpush(): Promise<number> {
    return 0;
  }

  async ltrim(): Promise<string> {
    return 'OK';
  }

  async lrange(): Promise<string[]> {
    return [];
  }

  async scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]> {
    const pattern = (args[1] as string | undefined) ?? '*';
    const regex = new RegExp(`^${pattern.replaceAll('*', '.*')}$`);
    const keys = [...this.strings.keys()].filter(k => regex.test(k));
    return ['0', keys];
  }

  ttlMs(key: string): number | null {
    this.pruneExpired(key);
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt === null) return null;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  async replaceJson(
    key: string,
    updater: (record: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const raw = await this.get(key);
    if (!raw) throw new Error(`Missing Redis key: ${key}`);
    const current = JSON.parse(raw) as Record<string, unknown>;
    const updated = updater(current);
    const ttlMs = this.ttlMs(key);
    if (ttlMs !== null) {
      await this.set(key, JSON.stringify(updated), 'PX', ttlMs);
      return;
    }
    await this.set(key, JSON.stringify(updated));
  }
}

describe('SQLite session repository', () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = createSqliteSessionRepository(db);
  });

  test('getSession enforces idle timeout', async () => {
    const config = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    await createSession(repo, 'user1', 'access-1', 'sid-sql-idle', undefined, config);
    db.run('UPDATE sessions SET lastActiveAt = ? WHERE sessionId = ?', [
      Date.now() - 2 * ONE_HOUR_MS,
      'sid-sql-idle',
    ]);

    expect(await getSession(repo, 'sid-sql-idle', config)).toBeNull();

    const row = db.query('SELECT token FROM sessions WHERE sessionId = ?').get('sid-sql-idle') as {
      token: string | null;
    } | null;
    expect(row?.token).toBeNull();
  });

  test('getSessionByRefreshToken enforces idle timeout', async () => {
    const config = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    await createSession(repo, 'user1', 'access-1', 'sid-sql-refresh', undefined, config);
    await setRefreshToken(repo, 'sid-sql-refresh', 'refresh-sql', config);
    db.run('UPDATE sessions SET lastActiveAt = ? WHERE sessionId = ?', [
      Date.now() - 2 * ONE_HOUR_MS,
      'sid-sql-refresh',
    ]);

    expect(await getSessionByRefreshToken(repo, 'refresh-sql', config)).toBeNull();
  });
});

describe('Memory session repository', () => {
  test('capacity eviction removes stale refresh-token and user-session indexes', async () => {
    const repo = createMemorySessionRepository();

    await createSession(repo, 'user1', 'access-old', 'sid-old');
    await setRefreshToken(repo, 'sid-old', 'refresh-old');

    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i++) {
      await createSession(repo, 'user1', `access-${i}`, `sid-${i}`);
    }

    expect(await getSession(repo, 'sid-old')).toBeNull();
    expect(await getSessionByRefreshToken(repo, 'refresh-old')).toBeNull();

    const sessions = await repo.getUserSessions('user1');
    expect(sessions).toHaveLength(DEFAULT_MAX_ENTRIES);
    expect(sessions.some(session => session.sessionId === 'sid-old')).toBe(false);
  });
});

describe('Redis session repository', () => {
  const appName = 'session-repo-test';
  let redis: FakeRedis;
  let repo: SessionRepository;

  beforeEach(() => {
    redis = new FakeRedis();
    repo = createRedisSessionRepository(() => redis, appName);
  });

  test('getSession enforces idle timeout', async () => {
    const config = createAuthResolvedConfig({ sessionPolicy: { idleTimeout: 3600 } });
    const sessionId = 'sid-redis-idle';
    await createSession(repo, 'user1', 'access-1', sessionId, undefined, config);
    await redis.replaceJson(`session:${appName}:${sessionId}`, record => ({
      ...record,
      lastActiveAt: Date.now() - 2 * ONE_HOUR_MS,
    }));

    expect(await getSession(repo, sessionId, config)).toBeNull();
  });

  test('setRefreshToken preserves TTL for non-persistent session records', async () => {
    const config = createAuthResolvedConfig({
      persistSessionMetadata: false,
      sessionPolicy: { absoluteTimeout: 60 },
      refreshToken: { refreshTokenExpiry: 300 },
    });
    const sessionId = 'sid-redis-set-refresh';
    const sessionKey = `session:${appName}:${sessionId}`;

    await createSession(repo, 'user1', 'access-1', sessionId, undefined, config);
    const beforeTtl = redis.ttlMs(sessionKey);
    expect(beforeTtl).not.toBeNull();

    await setRefreshToken(repo, sessionId, 'refresh-redis', config);

    const afterTtl = redis.ttlMs(sessionKey);
    expect(afterTtl).not.toBeNull();
    expect(afterTtl!).toBeGreaterThan(0);
  });

  test('rotateRefreshToken preserves TTL for non-persistent session records', async () => {
    const config = createAuthResolvedConfig({
      persistSessionMetadata: false,
      sessionPolicy: { absoluteTimeout: 60 },
      refreshToken: { refreshTokenExpiry: 300, rotationGraceSeconds: 30 },
    });
    const sessionId = 'sid-redis-rotate';
    const sessionKey = `session:${appName}:${sessionId}`;

    await createSession(repo, 'user1', 'access-1', sessionId, undefined, config);
    await setRefreshToken(repo, sessionId, 'refresh-before', config);
    const beforeTtl = redis.ttlMs(sessionKey);
    expect(beforeTtl).not.toBeNull();

    await rotateRefreshToken(repo, sessionId, undefined, 'refresh-after', 'access-2', config);

    const afterTtl = redis.ttlMs(sessionKey);
    expect(afterTtl).not.toBeNull();
    expect(afterTtl!).toBeGreaterThan(0);
  });
});
