import { hashToken, timingSafeEqual } from '@lastshotlabs/slingshot-core';
import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import type { RedisLike } from '../../types/redis';
import { getSessionTtlMs, getSessionTtlSeconds, isIdleExpired } from './policy';
import type { SessionRepository } from './repository';
import type { SessionInfo } from './types';

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis-backed session repository.
 *
 * Sessions are stored as JSON strings keyed by `session:{appName}:{sessionId}`.
 * User-to-session indexes use a sorted set keyed by score = `createdAt` (epoch ms),
 * enabling O(log N) oldest-session eviction. Refresh token lookup uses a separate
 * key per token hash.
 *
 * Atomic session creation and TTL management use Lua scripts to ensure consistency
 * under concurrent requests.
 *
 * @param getRedis - Factory that returns the shared `ioredis` client instance.
 * @param appName - Namespace prefix for all Redis keys (prevents key collisions across apps).
 * @returns A `SessionRepository` backed by Redis.
 *
 * @example
 * import { createRedisSessionRepository } from '@lastshotlabs/slingshot-auth';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const sessionRepo = createRedisSessionRepository(() => redis, 'my-app');
 *
 * @remarks
 * Requires ioredis 5+. The `appName` must be stable across deployments — changing it
 * invalidates all existing session keys.
 */
export function createRedisSessionRepository(
  getRedis: () => RedisLike,
  appName: string,
): SessionRepository {
  function sessionKey(sessionId: string) {
    return `session:${appName}:${sessionId}`;
  }
  function userSessionsKey(userId: string) {
    return `usersessions:${appName}:${userId}`;
  }
  function refreshTokenKey(refreshToken: string) {
    return `refreshtoken:${appName}:${refreshToken}`;
  }

  // Lua script: atomic session field update
  const UPDATE_FIELD_LUA = `
local key = KEYS[1]
local field = ARGV[1]
local value = ARGV[2]
local valueType = ARGV[3]
local nowMs = tonumber(ARGV[4])

local raw = redis.call('GET', key)
if not raw then return 0 end
local rec = cjson.decode(raw)
if valueType == "number" then
  rec[field] = tonumber(value)
else
  rec[field] = value
end
local ttl = redis.call('PTTL', key)
if ttl > 0 then
  redis.call('SET', key, cjson.encode(rec), 'PX', ttl)
elseif rec.expiresAt and rec.expiresAt > nowMs then
  redis.call('SET', key, cjson.encode(rec), 'PX', rec.expiresAt - nowMs)
elseif rec.expiresAt then
  redis.call('DEL', key)
else
  redis.call('SET', key, cjson.encode(rec))
end
return 1
`;

  const WRITE_SESSION_LUA = `
local key = KEYS[1]
local rawJson = ARGV[1]
local nowMs = tonumber(ARGV[2])

local rec = cjson.decode(rawJson)
local ttl = redis.call('PTTL', key)
if ttl > 0 then
  redis.call('SET', key, rawJson, 'PX', ttl)
elseif rec.expiresAt and rec.expiresAt > nowMs then
  redis.call('SET', key, rawJson, 'PX', rec.expiresAt - nowMs)
elseif rec.expiresAt then
  redis.call('DEL', key)
else
  redis.call('SET', key, rawJson)
end
return 1
`;

  // Lua script: atomic session creation
  const ATOMIC_CREATE_SESSION_LUA = `
local userSessionsKey = KEYS[1]
local newSessionKey = KEYS[2]
local maxSessions = tonumber(ARGV[1])
local sessionId = ARGV[2]
local sessionJson = ARGV[3]
local createdAt = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

local members = redis.call('ZRANGE', userSessionsKey, 0, -1)

local activeCount = 0
local activeSessions = {}
for i, sid in ipairs(members) do
  local keyPrefix = ARGV[6]
  local sKey = keyPrefix .. sid
  local raw = redis.call('GET', sKey)
  if raw then
    local rec = cjson.decode(raw)
    if rec.token and rec.expiresAt > createdAt then
      activeCount = activeCount + 1
      table.insert(activeSessions, { sid = sid, key = sKey, createdAt = rec.createdAt })
    end
  else
    redis.call('ZREM', userSessionsKey, sid)
  end
end

table.sort(activeSessions, function(a, b) return a.createdAt < b.createdAt end)

local evicted = 0
while activeCount >= maxSessions and evicted < #activeSessions do
  evicted = evicted + 1
  local victim = activeSessions[evicted]
  redis.call('DEL', victim.key)
  redis.call('ZREM', userSessionsKey, victim.sid)
  activeCount = activeCount - 1
end

redis.call('SET', newSessionKey, sessionJson, 'EX', ttlSeconds)
redis.call('ZADD', userSessionsKey, createdAt, sessionId)

return evicted
`;

  async function updateSessionField(
    sessionId: string,
    field: string,
    value: string | number,
  ): Promise<boolean> {
    const redis = getRedis();
    const key = sessionKey(sessionId);
    const valueType = typeof value === 'number' ? 'number' : 'string';
    const result = await redis.eval(
      UPDATE_FIELD_LUA,
      1,
      key,
      field,
      String(value),
      valueType,
      Date.now(),
    );
    return result === 1;
  }

  async function writeSessionRecord(
    sessionId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    const redis = getRedis();
    await redis.eval(
      WRITE_SESSION_LUA,
      1,
      sessionKey(sessionId),
      JSON.stringify(record),
      Date.now(),
    );
  }

  async function deleteSessionImpl(sessionId: string, cfg?: AuthResolvedConfig): Promise<void> {
    const c = cfg ?? DEFAULT_AUTH_CONFIG;
    const redis = getRedis();
    const raw = await redis.get(sessionKey(sessionId));
    if (!raw) return;
    const rec = JSON.parse(raw) as {
      userId: string;
      expiresAt: number;
      refreshToken?: string;
      prevRefreshToken?: string;
    };
    const persist = c.persistSessionMetadata;

    if (rec.refreshToken) await redis.del(refreshTokenKey(rec.refreshToken));
    if (rec.prevRefreshToken) await redis.del(refreshTokenKey(rec.prevRefreshToken));

    if (persist) {
      const updated = {
        ...rec,
        token: null,
        refreshToken: null,
        prevRefreshToken: null,
        prevTokenExpiresAt: null,
      };
      await writeSessionRecord(sessionId, updated);
    } else {
      await redis.del(sessionKey(sessionId));
    }
    if (!persist) {
      await redis.zrem(userSessionsKey(rec.userId), sessionId);
    }
  }

  async function getUserSessionsImpl(
    userId: string,
    cfg?: AuthResolvedConfig,
  ): Promise<SessionInfo[]> {
    const c = cfg ?? DEFAULT_AUTH_CONFIG;
    const redis = getRedis();
    const sessionIds = await redis.zrange(userSessionsKey(userId), 0, -1);
    if (!sessionIds.length) return [];
    const now = Date.now();
    const raws = await redis.mget(...sessionIds.map(sessionKey));
    const results: SessionInfo[] = [];
    const toRemove: string[] = [];
    for (let i = 0; i < sessionIds.length; i++) {
      const raw = raws[i];
      if (!raw) {
        toRemove.push(sessionIds[i]);
        continue;
      }
      const rec = JSON.parse(raw) as {
        sessionId: string;
        userId: string;
        token: string | null;
        createdAt: number;
        lastActiveAt: number;
        expiresAt: number;
        ipAddress?: string;
        userAgent?: string;
      };
      const isActive = !!rec.token && rec.expiresAt > now;
      if (!isActive && !c.persistSessionMetadata) {
        toRemove.push(sessionIds[i]);
        continue;
      }
      if (!isActive && !c.includeInactiveSessions) continue;
      results.push({
        sessionId: rec.sessionId,
        createdAt: rec.createdAt,
        lastActiveAt: rec.lastActiveAt,
        expiresAt: rec.expiresAt,
        ipAddress: rec.ipAddress,
        userAgent: rec.userAgent,
        isActive,
      });
    }
    if (toRemove.length) {
      await redis.zrem(userSessionsKey(userId), ...toRemove);
    }
    return results;
  }

  return {
    async createSession(userId, token, sessionId, metadata?, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const now = Date.now();
      const ttlSeconds = getSessionTtlSeconds(c);
      const expiresAt = now + getSessionTtlMs(c);
      const record = JSON.stringify({
        sessionId,
        userId,
        token,
        createdAt: now,
        lastActiveAt: now,
        expiresAt,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
      const redis = getRedis();
      await redis.set(sessionKey(sessionId), record, 'EX', ttlSeconds);
      await redis.zadd(userSessionsKey(userId), now, sessionId);
    },

    async atomicCreateSession(userId, token, sessionId, maxSessions, metadata?, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const now = Date.now();
      const ttlSeconds = getSessionTtlSeconds(c);
      const expiresAt = now + getSessionTtlMs(c);
      const record = JSON.stringify({
        sessionId,
        userId,
        token,
        createdAt: now,
        lastActiveAt: now,
        expiresAt,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
      const redis = getRedis();
      const sessionKeyPrefix = `session:${appName}:`;

      await redis.eval(
        ATOMIC_CREATE_SESSION_LUA,
        2,
        userSessionsKey(userId),
        sessionKey(sessionId),
        maxSessions,
        sessionId,
        record,
        now,
        ttlSeconds,
        sessionKeyPrefix,
      );
    },

    async getSession(sessionId, cfg?) {
      const raw = await getRedis().get(sessionKey(sessionId));
      if (!raw) return null;
      const rec = JSON.parse(raw) as {
        token: string | null;
        expiresAt: number;
        lastActiveAt?: number;
      };
      if (!rec.token) return null;
      if (rec.expiresAt <= Date.now()) return null;
      if (typeof rec.lastActiveAt === 'number' && isIdleExpired(rec.lastActiveAt, cfg)) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }
      return rec.token;
    },

    async deleteSession(sessionId, cfg?) {
      await deleteSessionImpl(sessionId, cfg);
    },

    async getUserSessions(userId, cfg?) {
      return getUserSessionsImpl(userId, cfg);
    },

    async getActiveSessionCount(userId, cfg?) {
      const sessions = await getUserSessionsImpl(userId, cfg);
      return sessions.filter(s => s.isActive).length;
    },

    async evictOldestSession(userId, cfg?) {
      const redis = getRedis();
      const sessionIds = await redis.zrange(userSessionsKey(userId), 0, -1);
      const now = Date.now();
      for (const sid of sessionIds) {
        const raw = await redis.get(sessionKey(sid));
        if (!raw) {
          await redis.zrem(userSessionsKey(userId), sid);
          continue;
        }
        const rec = JSON.parse(raw) as { token: string | null; expiresAt: number };
        if (rec.token && rec.expiresAt > now) {
          await deleteSessionImpl(sid, cfg);
          return;
        }
      }
    },

    async updateSessionLastActive(sessionId, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const now = Date.now();
      const updated = await updateSessionField(sessionId, 'lastActiveAt', now);
      if (!updated) return;
      if (!c.persistSessionMetadata) {
        const redis = getRedis();
        const raw = await redis.get(sessionKey(sessionId));
        if (raw) {
          const rec = JSON.parse(raw) as { expiresAt: number };
          if (rec.expiresAt <= now) {
            await deleteSessionImpl(sessionId, c);
          }
        }
      }
    },

    async setRefreshToken(sessionId, refreshToken, cfg?) {
      const redis = getRedis();
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return;
      const rec = JSON.parse(raw) as { refreshToken?: string | null } & Record<string, unknown>;
      const tokenHash = hashToken(refreshToken);
      const oldHash = typeof rec.refreshToken === 'string' ? rec.refreshToken : null;
      rec.refreshToken = tokenHash;
      const refreshExpiry =
        (cfg ?? DEFAULT_AUTH_CONFIG).refreshToken?.refreshTokenExpiry ?? 2_592_000;
      await writeSessionRecord(sessionId, rec);
      if (oldHash && oldHash !== tokenHash) {
        await redis.del(refreshTokenKey(oldHash));
      }
      await redis.set(refreshTokenKey(tokenHash), sessionId, 'EX', refreshExpiry);
    },

    async getSessionByRefreshToken(refreshToken, cfg?) {
      const redis = getRedis();
      const tokenHash = hashToken(refreshToken);
      const sessionId = await redis.get(refreshTokenKey(tokenHash));
      if (!sessionId) return null;
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return null;
      const rec = JSON.parse(raw) as {
        sessionId: string;
        userId: string;
        refreshToken?: string;
        prevRefreshToken?: string;
        prevTokenExpiresAt?: number;
        token?: string | null;
        lastActiveAt?: number;
        expiresAt?: number;
      };
      if (typeof rec.expiresAt === 'number' && rec.expiresAt <= Date.now()) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }

      if (typeof rec.lastActiveAt === 'number' && isIdleExpired(rec.lastActiveAt, cfg)) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }

      if (timingSafeEqual(rec.refreshToken ?? '', tokenHash)) {
        return {
          sessionId: rec.sessionId,
          userId: rec.userId,
          fromGrace: false,
        };
      }

      if (
        timingSafeEqual(rec.prevRefreshToken ?? '', tokenHash) &&
        rec.prevTokenExpiresAt &&
        rec.prevTokenExpiresAt > Date.now()
      ) {
        return {
          sessionId: rec.sessionId,
          userId: rec.userId,
          fromGrace: true,
        };
      }

      if (timingSafeEqual(rec.prevRefreshToken ?? '', tokenHash)) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }

      return null;
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, newAccessToken, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const redis = getRedis();
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return false;
      const rec = JSON.parse(raw) as {
        refreshToken?: string | null;
        prevRefreshToken?: string | null;
      } & Record<string, unknown>;
      // Guard: reject if another concurrent request already rotated the token.
      if (oldRefreshToken !== undefined) {
        const expectedHash = hashToken(oldRefreshToken);
        if (rec.refreshToken !== expectedHash) return false;
      }
      const graceSeconds = c.refreshToken?.rotationGraceSeconds ?? 10;
      const refreshExpiry = c.refreshToken?.refreshTokenExpiry ?? 2_592_000;
      const newHash = hashToken(newRefreshToken);

      const oldHash = rec.refreshToken;
      const oldPrevHash = rec.prevRefreshToken;
      rec.prevRefreshToken = oldHash;
      rec.prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      rec.refreshToken = newHash;
      rec.token = newAccessToken;

      await writeSessionRecord(sessionId, rec);
      await redis.set(refreshTokenKey(newHash), sessionId, 'EX', refreshExpiry);
      if (oldPrevHash && oldPrevHash !== oldHash) {
        await redis.del(refreshTokenKey(oldPrevHash));
      }
      if (oldHash) {
        await redis.expire(refreshTokenKey(oldHash), refreshExpiry);
      }
      return true;
    },

    async getSessionFingerprint(sessionId) {
      const redis = getRedis();
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return null;
      const rec = JSON.parse(raw) as { fingerprint?: string | null };
      return rec.fingerprint ?? null;
    },

    async setSessionFingerprint(sessionId, fingerprint) {
      await updateSessionField(sessionId, 'fingerprint', fingerprint);
    },

    async setMfaVerifiedAt(sessionId) {
      const now = Math.floor(Date.now() / 1000);
      await updateSessionField(sessionId, 'mfaVerifiedAt', now);
    },

    async getMfaVerifiedAt(sessionId) {
      const redis = getRedis();
      const raw = await redis.get(sessionKey(sessionId));
      if (!raw) return null;
      const rec = JSON.parse(raw) as { mfaVerifiedAt?: number | null };
      return rec.mfaVerifiedAt ?? null;
    },
  };
}
