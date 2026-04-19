/**
 * Integration tests for the Auth postgres adapter and 13 postgres repositories.
 *
 * Skipped when TEST_POSTGRES_URL is not set so CI can run without a live DB.
 * To run locally:
 *   TEST_POSTGRES_URL=postgres://localhost/slingshot_test bun test packages/slingshot-auth/tests/integration/postgres-auth.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const TEST_POSTGRES_URL = process.env['TEST_POSTGRES_URL'];

describe.skipIf(!TEST_POSTGRES_URL)('Auth postgres adapter integration', () => {
   
  let Pool: typeof import('pg').Pool;
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const pg = await import('pg');
    Pool = pg.Pool;
    pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  // Session repository
  // ---------------------------------------------------------------------------

  it('session repo: creates, reads, and deletes a session', async () => {
    const { createPostgresSessionRepository } = await import('../../src/lib/session');
    const repo = createPostgresSessionRepository(pool);

    const sessionId = `test-session-${Date.now()}`;
    const userId = `user-${Date.now()}`;
    const token = 'tok-abc';

    await repo.createSession(userId, token, sessionId, { ipAddress: '127.0.0.1' });
    const fetched = await repo.getSession(sessionId);
    expect(fetched).toBe(token);

    const sessions = await repo.getUserSessions(userId);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].sessionId).toBe(sessionId);

    const count = await repo.getActiveSessionCount(userId);
    expect(count).toBeGreaterThanOrEqual(1);

    await repo.deleteSession(sessionId);
    const afterDelete = await repo.getSession(sessionId);
    expect(afterDelete).toBeNull();
  });

  it('session repo: sets and gets fingerprint', async () => {
    const { createPostgresSessionRepository } = await import('../../src/lib/session');
    const repo = createPostgresSessionRepository(pool);

    const sessionId = `test-fp-${Date.now()}`;
    const userId = `user-fp-${Date.now()}`;
    await repo.createSession(userId, 'tok-fp', sessionId);

    await repo.setSessionFingerprint(sessionId, 'fp-hash-123');
    const fp = await repo.getSessionFingerprint(sessionId);
    expect(fp).toBe('fp-hash-123');

    await repo.deleteSession(sessionId);
  });

  it('session repo: sets and gets MFA verified at', async () => {
    const { createPostgresSessionRepository } = await import('../../src/lib/session');
    const repo = createPostgresSessionRepository(pool);

    const sessionId = `test-mfa-${Date.now()}`;
    const userId = `user-mfa-${Date.now()}`;
    await repo.createSession(userId, 'tok-mfa', sessionId);

    await repo.setMfaVerifiedAt(sessionId);
    const ts = await repo.getMfaVerifiedAt(sessionId);
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);

    await repo.deleteSession(sessionId);
  });

  // ---------------------------------------------------------------------------
  // OAuth state store
  // ---------------------------------------------------------------------------

  it('oauth state store: store and consume', async () => {
    const { createPostgresOAuthStateStore } = await import('../../src/lib/oauth');
    const store = createPostgresOAuthStateStore(pool);

    const state = `state-${Date.now()}`;
    await store.store(state, 'verifier-abc', 'user-link-id');
    const result = await store.consume(state);
    expect(result?.codeVerifier).toBe('verifier-abc');
    expect(result?.linkUserId).toBe('user-link-id');

    // Consuming again should return null (one-time use)
    const result2 = await store.consume(state);
    expect(result2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // OAuth code repository
  // ---------------------------------------------------------------------------

  it('oauth code repo: store and consume', async () => {
    const { createPostgresOAuthCodeRepository } = await import('../../src/lib/oauthCode');
    const repo = createPostgresOAuthCodeRepository(pool);

    const hash = `code-hash-${Date.now()}`;
    const payload = { token: 'access-tok', userId: 'u1', email: 'u@example.com' };
    await repo.store(hash, payload, 60);
    const result = await repo.consume(hash);
    expect(result?.token).toBe('access-tok');

    // One-time use
    const result2 = await repo.consume(hash);
    expect(result2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // OAuth reauth repository
  // ---------------------------------------------------------------------------

  it('oauth reauth repo: storeState and consumeState', async () => {
    const { createPostgresOAuthReauthRepository } = await import('../../src/lib/oauthReauth');
    const repo = createPostgresOAuthReauthRepository(pool);

    const hash = `reauth-${Date.now()}`;
    const data = {
      userId: 'u1',
      sessionId: 'sess1',
      provider: 'google',
      purpose: 'reauth',
      expiresAt: Date.now() + 300_000,
    };
    await repo.storeState(hash, data, 60);
    const result = await repo.consumeState(hash);
    expect(result?.userId).toBe('u1');
    expect(result?.provider).toBe('google');

    const result2 = await repo.consumeState(hash);
    expect(result2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Verification token repository
  // ---------------------------------------------------------------------------

  it('verification token repo: create, get, and consume', async () => {
    const { createPostgresVerificationTokenRepository } =
      await import('../../src/lib/emailVerification');
    const repo = createPostgresVerificationTokenRepository(pool);

    const hash = `verify-${Date.now()}`;
    await repo.create(hash, 'user-v1', 'v@example.com', 3600);

    const got = await repo.get(hash);
    expect(got?.userId).toBe('user-v1');
    expect(got?.email).toBe('v@example.com');

    const consumed = await repo.consume(hash);
    expect(consumed?.userId).toBe('user-v1');

    const gone = await repo.get(hash);
    expect(gone).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Reset token repository
  // ---------------------------------------------------------------------------

  it('reset token repo: create and consume', async () => {
    const { createPostgresResetTokenRepository } = await import('../../src/lib/resetPassword');
    const repo = createPostgresResetTokenRepository(pool);

    const hash = `reset-${Date.now()}`;
    await repo.create(hash, 'user-r1', 'r@example.com', 3600);
    const result = await repo.consume(hash);
    expect(result?.userId).toBe('user-r1');

    const result2 = await repo.consume(hash);
    expect(result2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Magic link repository
  // ---------------------------------------------------------------------------

  it('magic link repo: store and consume', async () => {
    const { createPostgresMagicLinkRepository } = await import('../../src/lib/magicLink');
    const repo = createPostgresMagicLinkRepository(pool);

    const hash = `ml-${Date.now()}`;
    await repo.store(hash, 'user-ml1', 900);
    const userId = await repo.consume(hash);
    expect(userId).toBe('user-ml1');

    const userId2 = await repo.consume(hash);
    expect(userId2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // MFA challenge repository
  // ---------------------------------------------------------------------------

  it('mfa challenge repo: createChallenge and consumeChallenge', async () => {
    const { createPostgresMfaChallengeRepository } = await import('../../src/lib/mfaChallenge');
    const repo = createPostgresMfaChallengeRepository(pool);

    const hash = `mfa-${Date.now()}`;
    const data = {
      userId: 'user-mfa1',
      purpose: 'login' as const,
      emailOtpHash: 'otp-hash',
      createdAt: Date.now(),
      resendCount: 0,
    };
    await repo.createChallenge(hash, data, 300);
    const result = await repo.consumeChallenge(hash);
    expect(result?.userId).toBe('user-mfa1');
    expect(result?.purpose).toBe('login');

    const result2 = await repo.consumeChallenge(hash);
    expect(result2).toBeNull();
  });

  it('mfa challenge repo: replaceOtp increments resend count', async () => {
    const { createPostgresMfaChallengeRepository } = await import('../../src/lib/mfaChallenge');
    const repo = createPostgresMfaChallengeRepository(pool);

    const hash = `mfa-resend-${Date.now()}`;
    const data = {
      userId: 'user-mfa2',
      purpose: 'login' as const,
      emailOtpHash: 'otp-original',
      createdAt: Date.now(),
      resendCount: 0,
    };
    await repo.createChallenge(hash, data, 300);
    const updated = await repo.replaceOtp(hash, 'otp-new', 300, 3);
    expect(updated?.resendCount).toBe(1);
    expect(updated?.userId).toBe('user-mfa2');

    await repo.consumeChallenge(hash);
  });

  it('mfa challenge repo: replaceOtp returns null after max resends', async () => {
    const { createPostgresMfaChallengeRepository } = await import('../../src/lib/mfaChallenge');
    const repo = createPostgresMfaChallengeRepository(pool);

    const hash = `mfa-resend-max-${Date.now()}`;
    const data = {
      userId: 'user-mfa3',
      purpose: 'login' as const,
      emailOtpHash: 'otp-original',
      createdAt: Date.now(),
      resendCount: 0,
    };
    await repo.createChallenge(hash, data, 300);

    expect((await repo.replaceOtp(hash, 'otp-1', 300, 3))?.resendCount).toBe(1);
    expect((await repo.replaceOtp(hash, 'otp-2', 300, 3))?.resendCount).toBe(2);
    expect((await repo.replaceOtp(hash, 'otp-3', 300, 3))?.resendCount).toBe(3);
    expect(await repo.replaceOtp(hash, 'otp-4', 300, 3)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Auth rate limit repository
  // ---------------------------------------------------------------------------

  it('auth rate limit repo: get, set, delete, and increment', async () => {
    const { createPostgresAuthRateLimitRepository } = await import('../../src/lib/authRateLimit');
    const repo = createPostgresAuthRateLimitRepository(pool);

    const key = `rl-${Date.now()}`;
    const now = Date.now();
    await repo.set(key, { count: 3, resetAt: now + 60_000 }, 60_000);

    const entry = await repo.get(key);
    expect(entry?.count).toBe(3);

    const newCount = await repo.increment!(key, 60_000);
    expect(newCount).toBeGreaterThanOrEqual(1);

    await repo.delete(key);
    const gone = await repo.get(key);
    expect(gone).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Credential stuffing repository
  // ---------------------------------------------------------------------------

  it('credential stuffing repo: addToSet and getSetSize', async () => {
    const { createPostgresCredentialStuffingRepository } =
      await import('../../src/lib/credentialStuffing');
    const repo = createPostgresCredentialStuffingRepository(pool);

    const key = `cs-ip-${Date.now()}`;
    const count1 = await repo.addToSet(key, 'account@a.com', 60_000);
    const count2 = await repo.addToSet(key, 'account@b.com', 60_000);
    expect(count1).toBe(1);
    expect(count2).toBe(2);

    const size = await repo.getSetSize(key, 60_000);
    expect(size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Account lockout repository
  // ---------------------------------------------------------------------------

  it('lockout repo: setAttempts, getAttempts, setLocked, isLocked, deleteLocked', async () => {
    const { createPostgresLockoutRepository } = await import('../../src/lib/accountLockout');
    const repo = createPostgresLockoutRepository(pool);

    const key = `lock-${Date.now()}`;
    await repo.setAttempts(key, 5, 60_000);
    const attempts = await repo.getAttempts(key);
    expect(attempts).toBe(5);

    await repo.setLocked(key, 60_000);
    const locked = await repo.isLocked(key);
    expect(locked).toBe(true);

    await repo.deleteLocked(key);
    const unLocked = await repo.isLocked(key);
    expect(unLocked).toBe(false);

    await repo.deleteAttempts(key);
    const noAttempts = await repo.getAttempts(key);
    expect(noAttempts).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Deletion cancel token repository
  // ---------------------------------------------------------------------------

  it('deletion cancel token repo: store and consume', async () => {
    const { createPostgresDeletionCancelTokenRepository } =
      await import('../../src/lib/deletionCancelToken');
    const repo = createPostgresDeletionCancelTokenRepository(pool);

    const hash = `del-${Date.now()}`;
    await repo.store(hash, 'user-d1', 'job-d1', 3600);
    const result = await repo.consume(hash);
    expect(result?.userId).toBe('user-d1');
    expect(result?.jobId).toBe('job-d1');

    const result2 = await repo.consume(hash);
    expect(result2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SAML request ID repository
  // ---------------------------------------------------------------------------

  it('saml request id repo: store and exists (consume-once)', async () => {
    const { createPostgresSamlRequestIdRepository } = await import('../../src/lib/samlRequestId');
    const repo = createPostgresSamlRequestIdRepository(pool);

    const hash = `saml-${Date.now()}`;
    await repo.store(hash, 300);
    const exists = await repo.exists(hash);
    expect(exists).toBe(true);

    // Already consumed — should not exist again
    const exists2 = await repo.exists(hash);
    expect(exists2).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Full bootstrap with postgres config
  // ---------------------------------------------------------------------------

  it('bootstrapAuth boots with postgres config', async () => {
    const { bootstrapAuth } = await import('../../src/bootstrap');
    const { makeEventBus } = await import('../helpers/runtime');

    const bus = makeEventBus();
    const result = await bootstrapAuth(
      {
        db: {
          auth: 'postgres',
          postgres: TEST_POSTGRES_URL!,
          sessions: 'postgres',
          oauthState: 'postgres',
        },
        auth: { enabled: false },
      },
      bus,
      undefined,
      {
        signing: { secret: 'integration-test-signing-secret-1234567890' },
        dataEncryptionKeys: [],
        password: Bun.password,
      },
    );

    expect(result.adapter).toBeDefined();
    expect(result.stores.authStore).toBe('postgres');
    expect(result.stores.sessions).toBe('postgres');

    // Tear down pool created during bootstrap
    for (const fn of result.teardownFns) {
      await fn();
    }
  });
});
