import { describe, expect, test } from 'bun:test';
import { verifyToken } from '../../src/lib/jwt';
import {
  assertLoginEmailVerified,
  createSessionForUser,
  emitLoginSuccess,
  login,
  logout,
  makeDummyHashGetter,
  refresh,
  register,
  runPreLoginHook,
} from '../../src/services/auth';
import { makeEventBus, makeTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// createSessionForUser
// ---------------------------------------------------------------------------

describe('createSessionForUser', () => {
  test('returns a valid JWT token with correct sub claim', async () => {
    const runtime = makeTestRuntime();
    const { token } = await createSessionForUser('user-1', runtime);
    const payload = await verifyToken(token, runtime.config, runtime.signing);
    expect(payload.sub).toBe('user-1');
  });

  test('creates a session in the session repository', async () => {
    const runtime = makeTestRuntime();
    const { sessionId } = await createSessionForUser('user-1', runtime);
    const sessions = await runtime.repos.session.getUserSessions('user-1', runtime.config);
    const ids = sessions.map(s => s.sessionId);
    expect(ids).toContain(sessionId);
  });

  test('token contains jti claim', async () => {
    const runtime = makeTestRuntime();
    const { token } = await createSessionForUser('user-1', runtime);
    const payload = await verifyToken(token, runtime.config, runtime.signing);
    expect(payload.jti).toBeString();
    expect((payload.jti as string).length).toBeGreaterThan(0);
  });

  test('token contains sid claim matching returned sessionId', async () => {
    const runtime = makeTestRuntime();
    const { token, sessionId } = await createSessionForUser('user-1', runtime);
    const payload = await verifyToken(token, runtime.config, runtime.signing);
    expect(payload.sid).toBe(sessionId);
  });

  test('with refresh config, returns refreshToken', async () => {
    const runtime = makeTestRuntime({
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    const { refreshToken } = await createSessionForUser('user-1', runtime);
    expect(refreshToken).toBeString();
    expect(refreshToken!.length).toBeGreaterThan(0);
  });

  test('without refresh config, no refreshToken', async () => {
    const runtime = makeTestRuntime({ refreshToken: undefined });
    const { refreshToken } = await createSessionForUser('user-1', runtime);
    expect(refreshToken).toBeUndefined();
  });

  test('emits security.auth.session.created event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await createSessionForUser('user-1', runtime);
    expect(events).toContain('security.auth.session.created');
  });

  test('respects maxSessions by evicting oldest', async () => {
    const runtime = makeTestRuntime({ maxSessions: 2 });
    const { sessionId: s1 } = await createSessionForUser('user-1', runtime);
    await createSessionForUser('user-1', runtime);
    await createSessionForUser('user-1', runtime);
    const sessions = await runtime.repos.session.getUserSessions('user-1', runtime.config);
    const ids = sessions.map(s => s.sessionId);
    // The first session should have been evicted
    expect(ids).not.toContain(s1);
    expect(sessions.length).toBeLessThanOrEqual(2);
  });

  test('passes metadata to session (ipAddress, userAgent)', async () => {
    const runtime = makeTestRuntime();
    const { sessionId } = await createSessionForUser('user-1', runtime, {
      ipAddress: '10.0.0.1',
      userAgent: 'TestBrowser/1.0',
    });
    const sessions = await runtime.repos.session.getUserSessions('user-1', runtime.config);
    const session = sessions.find(s => s.sessionId === sessionId);
    expect(session).toBeDefined();
    expect(session!.ipAddress).toBe('10.0.0.1');
    expect(session!.userAgent).toBe('TestBrowser/1.0');
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('login', () => {
  async function seedUser(runtime: ReturnType<typeof makeTestRuntime>, email = 'alice@test.com') {
    const hashed = await runtime.password.hash('correct-password');
    return runtime.adapter.create(email, hashed);
  }

  test('successful login returns token and userId', async () => {
    const runtime = makeTestRuntime();
    const user = await seedUser(runtime);
    const result = await login('alice@test.com', 'correct-password', runtime);
    expect(result.token).toBeString();
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.userId).toBe(user.id);
  });

  test('wrong password throws 401', async () => {
    const runtime = makeTestRuntime();
    await seedUser(runtime);
    await expect(login('alice@test.com', 'wrong-password', runtime)).rejects.toThrow(
      'Invalid credentials',
    );
  });

  test('non-existent user throws 401 (timing-safe)', async () => {
    const runtime = makeTestRuntime();
    // Pre-warm the dummy hash so the timing-safe path is exercised
    await runtime.getDummyHash();
    await expect(login('nobody@test.com', 'any-password', runtime)).rejects.toThrow(
      'Invalid credentials',
    );
  });

  test('locked-out user is rejected with 401', async () => {
    const runtime = makeTestRuntime();
    // Inject lockout service
    const { createLockoutService, createMemoryLockoutRepository } =
      await import('../../src/lib/accountLockout');
    const lockoutRepo = createMemoryLockoutRepository();
    const lockoutService = createLockoutService(
      { maxAttempts: 3, lockoutDuration: 600 },
      lockoutRepo,
    );
    runtime.lockout = lockoutService;
    // Rebuild securityGate so it sees the lockout service
    const { createSecurityGate } = await import('../../src/lib/securityGate');
    const { createAuthRateLimitService, createMemoryAuthRateLimitRepository } =
      await import('../../src/lib/authRateLimit');
    runtime.securityGate = createSecurityGate(
      createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
      () => runtime.credentialStuffing,
      () => runtime.lockout,
      { windowMs: 15 * 60 * 1000, max: 100 },
    );

    const user = await seedUser(runtime);
    // Lock the account
    await lockoutService.lockAccount(user.id);

    await expect(login('alice@test.com', 'correct-password', runtime)).rejects.toThrow(
      'Invalid credentials',
    );
  });

  test('login emits security.auth.login.success event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await seedUser(runtime);
    await login('alice@test.com', 'correct-password', runtime);
    expect(events).toContain('security.auth.login.success');
  });

  test('login emits auth:login event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await seedUser(runtime);
    await login('alice@test.com', 'correct-password', runtime);
    expect(events).toContain('auth:login');
  });

  test('failed login emits security.auth.login.failure event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await seedUser(runtime);
    try {
      await login('alice@test.com', 'wrong-password', runtime);
    } catch {
      // expected
    }
    expect(events).toContain('security.auth.login.failure');
  });

  test('suspended user throws 403', async () => {
    const runtime = makeTestRuntime();
    const user = await seedUser(runtime);
    // Suspend via adapter
    if (runtime.adapter.setSuspended) {
      await runtime.adapter.setSuspended(user.id, true, 'test suspension');
    }
    await expect(login('alice@test.com', 'correct-password', runtime)).rejects.toThrow(
      'Account suspended',
    );
  });

  test('login token contains sub claim matching userId', async () => {
    const runtime = makeTestRuntime();
    const user = await seedUser(runtime);
    const result = await login('alice@test.com', 'correct-password', runtime);
    const payload = await verifyToken(result.token, runtime.config, runtime.signing);
    expect(payload.sub).toBe(user.id);
  });
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe('register', () => {
  test('creates user and returns token and userId', async () => {
    const runtime = makeTestRuntime();
    const result = await register('bob@test.com', 'strong-password-123', runtime);
    expect(result.token).toBeString();
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.userId).toBeString();
    expect(result.email).toBe('bob@test.com');
  });

  test('duplicate identifier throws 409', async () => {
    const runtime = makeTestRuntime();
    await register('bob@test.com', 'strong-password-123', runtime);
    await expect(register('bob@test.com', 'another-password-456', runtime)).rejects.toThrow(
      'Email already registered',
    );
  });

  test('emits security.auth.register.success event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await register('carol@test.com', 'strong-password-123', runtime);
    expect(events).toContain('security.auth.register.success');
  });

  test('emits auth:user.created event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    await register('carol@test.com', 'strong-password-123', runtime);
    expect(events).toContain('auth:user.created');
  });

  test('failed registration emits security.auth.register.failure event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    // Register once
    await register('dup@test.com', 'password-123', runtime);
    // Attempt duplicate
    try {
      await register('dup@test.com', 'password-456', runtime);
    } catch {
      // expected
    }
    expect(events).toContain('security.auth.register.failure');
  });

  test('skipSession option returns empty token', async () => {
    const runtime = makeTestRuntime();
    const result = await register('nosession@test.com', 'password-123', runtime, {
      skipSession: true,
    });
    expect(result.token).toBe('');
    expect(result.userId).toBeString();
  });

  test('user can login after registration', async () => {
    const runtime = makeTestRuntime();
    await register('logmein@test.com', 'my-password-abc', runtime);
    const result = await login('logmein@test.com', 'my-password-abc', runtime);
    expect(result.token).toBeString();
    expect(result.token.length).toBeGreaterThan(0);
  });

  test('assigns default role when configured', async () => {
    const runtime = makeTestRuntime({ defaultRole: 'member' });
    const result = await register('role@test.com', 'password-123', runtime);
    // Verify the user has the role
    const roles = await runtime.adapter.getRoles!(result.userId);
    expect(roles).toContain('member');
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  test('valid token deletes session', async () => {
    const runtime = makeTestRuntime();
    const { token, sessionId } = await createSessionForUser('user-1', runtime);
    // Confirm session exists
    const before = await runtime.repos.session.getUserSessions('user-1', runtime.config);
    expect(before.map(s => s.sessionId)).toContain(sessionId);

    await logout(token, runtime);

    const after = await runtime.repos.session.getUserSessions('user-1', runtime.config);
    expect(after.map(s => s.sessionId)).not.toContain(sessionId);
  });

  test('null token is handled gracefully (no-op)', async () => {
    const runtime = makeTestRuntime();
    // Should not throw
    await logout(null, runtime);
  });

  test('logout emits security.auth.logout event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    const { token } = await createSessionForUser('user-1', runtime);
    await logout(token, runtime);
    expect(events).toContain('security.auth.logout');
  });

  test('logout emits auth:logout event', async () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    const { token } = await createSessionForUser('user-1', runtime);
    await logout(token, runtime);
    expect(events).toContain('auth:logout');
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('refresh', () => {
  test('exchanges a refresh token for a new access token', async () => {
    const runtime = makeTestRuntime({
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    const { refreshToken } = await createSessionForUser('user-1', runtime);
    expect(refreshToken).toBeString();

    const result = await refresh(refreshToken!, runtime);
    expect(result.token).toBeString();
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.refreshToken).toBeString();
    expect(result.userId).toBe('user-1');
    // New refresh token should differ from the old one
    expect(result.refreshToken).not.toBe(refreshToken);
  });

  test('invalid refresh token throws 401', async () => {
    const runtime = makeTestRuntime({
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    await expect(refresh('bogus-token', runtime)).rejects.toThrow(
      'Invalid or expired refresh token',
    );
  });

  test('refreshed token has correct sub claim', async () => {
    const runtime = makeTestRuntime({
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    const { refreshToken } = await createSessionForUser('user-42', runtime);
    const result = await refresh(refreshToken!, runtime);
    const payload = await verifyToken(result.token, runtime.config, runtime.signing);
    expect(payload.sub).toBe('user-42');
  });

  test('suspended user cannot refresh', async () => {
    const runtime = makeTestRuntime({
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    const user = await runtime.adapter.create('suspend-refresh@test.com', 'hash');
    const { refreshToken } = await createSessionForUser(user.id, runtime);
    await runtime.adapter.setSuspended?.(user.id, true, 'security lock');

    await expect(refresh(refreshToken!, runtime)).rejects.toThrow('Account suspended');
  });

  test('required email verification blocks refresh for unverified users', async () => {
    const runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
    });
    const user = await runtime.adapter.create('refresh-unverified@test.com', 'hash');
    await runtime.adapter.setEmailVerified?.(user.id, true);
    const { refreshToken } = await createSessionForUser(user.id, runtime);
    await runtime.adapter.setEmailVerified?.(user.id, false);

    await expect(refresh(refreshToken!, runtime)).rejects.toThrow('Email not verified');
  });
});

// ---------------------------------------------------------------------------
// makeDummyHashGetter
// ---------------------------------------------------------------------------

describe('makeDummyHashGetter', () => {
  test('returns a valid password hash string', async () => {
    const getDummy = makeDummyHashGetter(Bun.password);
    const hash = await getDummy();
    expect(hash).toBeString();
    expect(hash.length).toBeGreaterThan(0);
  });

  test('hash is cached (same value on repeated calls)', async () => {
    const getDummy = makeDummyHashGetter(Bun.password);
    const h1 = await getDummy();
    const h2 = await getDummy();
    expect(h1).toBe(h2);
  });

  test('Bun.password.verify returns false against the dummy hash with a real password', async () => {
    const getDummy = makeDummyHashGetter(Bun.password);
    const hash = await getDummy();
    const valid = await Bun.password.verify('some-real-password', hash);
    expect(valid).toBe(false);
  });

  test('each factory call produces an independent instance', async () => {
    const getDummy1 = makeDummyHashGetter(Bun.password);
    const getDummy2 = makeDummyHashGetter(Bun.password);
    // Both produce hashes but they are independent closures
    const h1 = await getDummy1();
    const h2 = await getDummy2();
    // Both are valid hashes (may differ due to independent bcrypt salts)
    expect(h1).toBeString();
    expect(h2).toBeString();
  });
});

// ---------------------------------------------------------------------------
// emitLoginSuccess / runPreLoginHook
// ---------------------------------------------------------------------------

describe('emitLoginSuccess', () => {
  test('emits both security and app events', () => {
    const events: string[] = [];
    const runtime = makeTestRuntime();
    runtime.eventBus = makeEventBus(e => events.push(e));
    emitLoginSuccess('user-1', 'session-1', runtime);
    expect(events).toContain('security.auth.login.success');
    expect(events).toContain('auth:login');
  });
});

describe('runPreLoginHook', () => {
  test('calls preLogin hook when configured', async () => {
    let hookCalled = false;
    const runtime = makeTestRuntime({
      hooks: {
        preLogin: async () => {
          hookCalled = true;
        },
      },
    });
    await runPreLoginHook('alice@test.com', runtime);
    expect(hookCalled).toBe(true);
  });

  test('no-op when preLogin hook is not set', async () => {
    const runtime = makeTestRuntime({ hooks: {} });
    // Should not throw
    await runPreLoginHook('alice@test.com', runtime);
  });
});

describe('assertLoginEmailVerified', () => {
  test('throws when email verification is required and the user is unverified', async () => {
    const runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
    });
    const user = await runtime.adapter.create('needs-verify@test.com', 'hash');
    await runtime.adapter.setEmailVerified?.(user.id, false);

    await expect(assertLoginEmailVerified(user.id, runtime)).rejects.toThrow('Email not verified');
  });

  test('allows login when email verification is not required', async () => {
    const runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: false, tokenExpiry: 86400 },
    });
    const user = await runtime.adapter.create('verified-optional@test.com', 'hash');
    await runtime.adapter.setEmailVerified?.(user.id, false);

    await expect(assertLoginEmailVerified(user.id, runtime)).resolves.toBeUndefined();
  });
});
