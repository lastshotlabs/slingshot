import { hashToken } from '@lastshotlabs/slingshot-core';
import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '../../config/authConfig';
import { getSessionTtlMs, isIdleExpired, shouldPersistSessionMetadata } from './policy';
import type { SessionRepository } from './repository';
import type { SessionInfo } from './types';

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface SessionDoc {
  sessionId: string;
  userId: string;
  token: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  refreshToken?: string | null;
  prevRefreshToken?: string | null;
  prevTokenExpiresAt?: Date | null;
  fingerprint?: string | null;
  mfaVerifiedAt?: number | null;
}

/**
 * Creates a MongoDB-backed session repository using Mongoose.
 *
 * Registers (or reuses) the `Session` model on the provided connection. Uses MongoDB
 * transactions for atomic session creation when a `maxSessions` limit is enforced.
 * A TTL index on `expiresAt` (expireAfterSeconds: 0) handles natural expiration unless
 * `persistSessionMetadata` is enabled, in which case the TTL index is omitted and
 * expired tokens are nulled out instead of deleted.
 *
 * @param conn - A Mongoose `Connection` instance (auth connection, not the app connection).
 * @param mg - The `mongoose` module (passed explicitly to avoid peer-dep resolution issues).
 * @returns A `SessionRepository` backed by MongoDB.
 *
 * @example
 * import { createMongoSessionRepository } from '@lastshotlabs/slingshot-auth';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(process.env.MONGO_URI!).asPromise();
 * const sessionRepo = createMongoSessionRepository(conn, mongoose);
 *
 * @remarks
 * Requires mongoose 9+. The `Session` model is registered on the provided connection
 * only — it does not pollute the global `mongoose.models` registry.
 */
export function createMongoSessionRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): SessionRepository {
  type MongoClientSession = Awaited<ReturnType<typeof conn.startSession>>;

  let sessionModel: import('mongoose').Model<SessionDoc> | null = null;
  let standaloneFallbackQueue = Promise.resolve();

  function isTransactionUnsupportedError(error: unknown): boolean {
    const err = error as {
      code?: unknown;
      codeName?: unknown;
      message?: unknown;
      errorResponse?: { code?: unknown; codeName?: unknown; errmsg?: unknown };
    };
    const message = String(err.message ?? err.errorResponse?.errmsg ?? '');
    return (
      err.code === 20 ||
      err.errorResponse?.code === 20 ||
      err.codeName === 'IllegalOperation' ||
      err.errorResponse?.codeName === 'IllegalOperation' ||
      message.includes('Transaction numbers are only allowed on a replica set member or mongos')
    );
  }

  async function runStandaloneFallback(fn: () => Promise<void>): Promise<void> {
    const previous = standaloneFallbackQueue;
    let release!: () => void;
    standaloneFallbackQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      await fn();
    } finally {
      release();
    }
  }

  function getSessionModel(cfg?: AuthResolvedConfig): import('mongoose').Model<SessionDoc> {
    if (sessionModel) return sessionModel;
    if ('Session' in conn.models) {
      sessionModel = conn.models['Session'] as unknown as import('mongoose').Model<SessionDoc>;
      return sessionModel;
    }
    const { Schema } = mg;
    const persistSessionMetadata = shouldPersistSessionMetadata(cfg);
    const sessionSchema = new Schema<SessionDoc>(
      {
        sessionId: { type: String, required: true, unique: true },
        userId: { type: String, required: true, index: true },
        token: { type: String, default: null },
        createdAt: { type: Date, required: true },
        lastActiveAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        ipAddress: { type: String },
        userAgent: { type: String },
        refreshToken: { type: String, default: null },
        prevRefreshToken: { type: String, default: null },
        prevTokenExpiresAt: { type: Date, default: null },
        fingerprint: { type: String, default: null },
        mfaVerifiedAt: { type: Number, default: null },
      },
      { collection: 'sessions', timestamps: false, autoIndex: false },
    );
    sessionSchema.index(
      { refreshToken: 1 },
      { unique: true, partialFilterExpression: { refreshToken: { $type: 'string' } } },
    );
    if (!persistSessionMetadata) {
      sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
    sessionModel = conn.model('Session', sessionSchema);
    return sessionModel;
  }

  function deleteSessionImpl(sessionId: string, cfg?: AuthResolvedConfig): Promise<void> {
    const c = cfg ?? DEFAULT_AUTH_CONFIG;
    const Session = getSessionModel(c);
    if (c.persistSessionMetadata) {
      return Session.updateOne(
        { sessionId },
        {
          $set: {
            token: null,
            refreshToken: null,
            prevRefreshToken: null,
            prevTokenExpiresAt: null,
          },
        },
      ).then(() => {});
    }
    return Session.deleteOne({ sessionId }).then(() => {});
  }

  return {
    async createSession(userId, token, sessionId, metadata?, cfg?) {
      const now = new Date();
      const expiresAt = new Date(Date.now() + getSessionTtlMs(cfg));
      await getSessionModel(cfg).create({
        sessionId,
        userId,
        token,
        createdAt: now,
        lastActiveAt: now,
        expiresAt,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
    },

    async atomicCreateSession(userId, token, sessionId, maxSessions, metadata?, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const createLimitedSession = async (session?: MongoClientSession): Promise<void> => {
        const Session = getSessionModel(c);
        const now = new Date();
        const sessionOptions = session ? { session } : undefined;
        let activeCount = await Session.countDocuments(
          { userId, token: { $ne: null }, expiresAt: { $gt: now } },
          sessionOptions,
        );

        while (activeCount >= maxSessions) {
          const oldest = await Session.findOne(
            { userId, token: { $ne: null }, expiresAt: { $gt: now } },
            'sessionId',
            { ...(sessionOptions ?? {}), sort: { createdAt: 1 } },
          ).lean();
          if (!oldest) break;
          if (c.persistSessionMetadata) {
            await Session.updateOne(
              { sessionId: oldest.sessionId },
              {
                $set: {
                  token: null,
                  refreshToken: null,
                  prevRefreshToken: null,
                  prevTokenExpiresAt: null,
                },
              },
              sessionOptions,
            );
          } else {
            await Session.deleteOne({ sessionId: oldest.sessionId }, sessionOptions);
          }
          activeCount--;
        }

        const expiresAt = new Date(Date.now() + getSessionTtlMs(c));
        await Session.create(
          [
            {
              sessionId,
              userId,
              token,
              createdAt: now,
              lastActiveAt: now,
              expiresAt,
              ipAddress: metadata?.ipAddress,
              userAgent: metadata?.userAgent,
            },
          ],
          sessionOptions,
        );
      };

      const session = await conn.startSession();
      try {
        await session.withTransaction(async () => {
          await createLimitedSession(session);
        });
      } catch (error) {
        if (!isTransactionUnsupportedError(error)) throw error;
        await runStandaloneFallback(() => createLimitedSession());
      } finally {
        await session.endSession();
      }
    },

    async getSession(sessionId, cfg?) {
      const doc = (await getSessionModel(cfg)
        .findOne({ sessionId, expiresAt: { $gt: new Date() } }, 'token lastActiveAt')
        .lean()) as SessionDoc | null;
      if (!doc?.token) return null;
      if (isIdleExpired(doc.lastActiveAt.getTime(), cfg)) {
        await deleteSessionImpl(sessionId, cfg);
        return null;
      }
      return doc.token;
    },

    async deleteSession(sessionId, cfg?) {
      await deleteSessionImpl(sessionId, cfg);
    },

    async getUserSessions(userId, cfg?) {
      const c = cfg ?? DEFAULT_AUTH_CONFIG;
      const now = new Date();
      const includeInactive = c.includeInactiveSessions;
      const persist = c.persistSessionMetadata;
      const query: Record<string, unknown> = { userId };
      if (!includeInactive) {
        query.token = { $ne: null };
        query.expiresAt = { $gt: now };
      }
      const docs = await getSessionModel(cfg).find(query).lean();
      const results: SessionInfo[] = [];
      for (const doc of docs) {
        const isActive = !!doc.token && doc.expiresAt > now;
        if (!isActive && !persist) continue;
        if (!isActive && !includeInactive) continue;
        results.push({
          sessionId: doc.sessionId,
          createdAt: doc.createdAt.getTime(),
          lastActiveAt: doc.lastActiveAt.getTime(),
          expiresAt: doc.expiresAt.getTime(),
          ipAddress: doc.ipAddress,
          userAgent: doc.userAgent,
          isActive,
        });
      }
      return results;
    },

    async getActiveSessionCount(userId) {
      const now = new Date();
      return getSessionModel().countDocuments({
        userId,
        token: { $ne: null },
        expiresAt: { $gt: now },
      });
    },

    async evictOldestSession(userId, cfg?) {
      const now = new Date();
      const oldest = await getSessionModel(cfg)
        .findOne({ userId, token: { $ne: null }, expiresAt: { $gt: now } }, 'sessionId')
        .sort({ createdAt: 1 })
        .lean();
      if (oldest) await deleteSessionImpl(oldest.sessionId, cfg);
    },

    async updateSessionLastActive(sessionId) {
      await getSessionModel().updateOne({ sessionId }, { $set: { lastActiveAt: new Date() } });
    },

    async setRefreshToken(sessionId, refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await getSessionModel().updateOne({ sessionId }, { $set: { refreshToken: tokenHash } });
    },

    async getSessionByRefreshToken(refreshToken, cfg?) {
      const Session = getSessionModel(cfg);
      const tokenHash = hashToken(refreshToken);

      let doc = (await Session.findOne({ refreshToken: tokenHash }).lean()) as SessionDoc | null;
      if (doc) {
        if (isIdleExpired(doc.lastActiveAt.getTime(), cfg)) {
          await deleteSessionImpl(doc.sessionId, cfg);
          return null;
        }
        return {
          sessionId: doc.sessionId,
          userId: doc.userId,
          fromGrace: false,
        };
      }

      doc = (await Session.findOne({ prevRefreshToken: tokenHash }).lean()) as SessionDoc | null;
      if (!doc) return null;
      if (isIdleExpired(doc.lastActiveAt.getTime(), cfg)) {
        await deleteSessionImpl(doc.sessionId, cfg);
        return null;
      }

      if (doc.prevTokenExpiresAt && doc.prevTokenExpiresAt > new Date()) {
        return {
          sessionId: doc.sessionId,
          userId: doc.userId,
          fromGrace: true,
        };
      }

      await deleteSessionImpl(doc.sessionId, cfg);
      return null;
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, newAccessToken, cfg?) {
      const graceSeconds = (cfg ?? DEFAULT_AUTH_CONFIG).refreshToken?.rotationGraceSeconds ?? 10;
      const Session = getSessionModel(cfg);
      const newHash = hashToken(newRefreshToken);
      const prevTokenExpiresAt = new Date(Date.now() + graceSeconds * 1000);

      // Use findOneAndUpdate with an aggregation pipeline so prevRefreshToken can be set
      // to the current refreshToken value atomically in a single round-trip.
      // If oldRefreshToken is provided, add it as a guard condition — the update matches
      // only if the current token still equals the expected hash; 0 matches = already rotated.
      const filter: Record<string, unknown> = { sessionId };
      if (oldRefreshToken !== undefined) {
        filter.refreshToken = hashToken(oldRefreshToken);
      }
      const result = await Session.findOneAndUpdate(
        filter,
        [
          {
            $set: {
              prevRefreshToken: '$refreshToken',
              prevTokenExpiresAt,
              refreshToken: newHash,
              token: newAccessToken,
            },
          },
        ],
        // updatePipeline is required for aggregation-pipeline updates in Mongoose.
        // The pipeline sets prevRefreshToken = current refreshToken atomically.
        { new: false, updatePipeline: true },
      );
      return result !== null;
    },

    async getSessionFingerprint(sessionId) {
      const doc = await getSessionModel().findOne({ sessionId }, 'fingerprint').lean();
      return (doc as SessionDoc | null)?.fingerprint ?? null;
    },

    async setSessionFingerprint(sessionId, fingerprint) {
      await getSessionModel().updateOne({ sessionId }, { $set: { fingerprint } });
    },

    async setMfaVerifiedAt(sessionId) {
      const now = Math.floor(Date.now() / 1000);
      await getSessionModel().updateOne({ sessionId }, { $set: { mfaVerifiedAt: now } });
    },

    async getMfaVerifiedAt(sessionId) {
      const doc = await getSessionModel().findOne({ sessionId }, 'mfaVerifiedAt').lean();
      return (doc as SessionDoc | null)?.mfaVerifiedAt ?? null;
    },
  };
}
