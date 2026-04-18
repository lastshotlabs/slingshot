import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { signToken } from '@auth/lib/jwt';
import {
  type SessionRepository,
  createMemorySessionRepository,
  createSession,
  getSessionFingerprint,
  setSessionFingerprint,
} from '@auth/lib/session';
import { createIdentifyMiddleware } from '@auth/middleware/identify';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';

type SessionBindingConfig = {
  fields?: Array<'ip' | 'ua' | 'accept-language'>;
  onMismatch?: 'reject' | 'unauthenticate' | 'log-only';
};

type SigningFixture = {
  secret?: string | string[];
  sessionBinding?: SessionBindingConfig;
};

const DEFAULT_SIGNING: SigningFixture = { secret: 'test-jwt-secret-32-chars-long-xxx' };

let sessionRepo: SessionRepository;

beforeEach(() => {
  sessionRepo = createMemorySessionRepository();
});

async function makeSessionToken(
  userId: string,
  sessionId: string,
  signing?: SigningFixture | null,
): Promise<string> {
  const effectiveSigning = signing ? { ...DEFAULT_SIGNING, ...signing } : DEFAULT_SIGNING;
  const token = await signToken(
    { sub: userId, sid: sessionId },
    undefined,
    DEFAULT_AUTH_CONFIG,
    effectiveSigning,
  );
  await createSession(sessionRepo, userId, token, sessionId, {
    ipAddress: '127.0.0.1',
    userAgent: 'TestAgent/1.0',
  });
  return token;
}

async function buildApp(signing?: SigningFixture | null | undefined) {
  // Merge with default signing to ensure secret is always present
  signing = signing ? { ...DEFAULT_SIGNING, ...signing } : DEFAULT_SIGNING;
  const app = new Hono();
  const runtime = {
    adapter: {} as never,
    eventBus: { emit() {} } as never,
    config: DEFAULT_AUTH_CONFIG,
    stores: {} as never,
    signing: signing ?? null,
    dataEncryptionKeys: [],
    oauth: { providers: {}, stateStore: {} } as never,
    lockout: null,
    rateLimit: {} as never,
    credentialStuffing: null,
    queueFactory: null,
    repos: {
      oauthCode: {} as never,
      oauthReauth: {} as never,
      magicLink: {} as never,
      deletionCancelToken: {} as never,
      mfaChallenge: {} as never,
      samlRequestId: null,
      verificationToken: {} as never,
      resetToken: {} as never,
      session: sessionRepo,
    },
  };
  app.use('/*', async (c, next) => {
    (c as any).set('slingshotCtx', { signing: signing ?? null });
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.message };
      if (err.code !== undefined) body.code = err.code;
      return c.json(body, err.status as 400 | 401 | 403 | 404 | 409 | 418 | 429 | 500);
    }
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.use('/*', createIdentifyMiddleware(runtime as any));
  app.get('/me', c => {
    const userId = (c as any).get('authUserId');
    return c.json({ userId });
  });
  return app;
}

describe('session binding', () => {
  test('no binding configured: always authenticates', async () => {
    const app = await buildApp();
    const token = await makeSessionToken('user-1', 'sess-1');

    const res = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'BrowserA/1.0' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBe('user-1');
  });

  test('same fingerprint: authenticated', async () => {
    const signing = {
      sessionBinding: { fields: ['ua'], onMismatch: 'reject' } satisfies SessionBindingConfig,
    };
    const app = await buildApp(signing);
    const token = await makeSessionToken('user-2', 'sess-2', signing);

    // First request — stores fingerprint
    const res1 = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'SameAgent/1.0' },
    });
    expect(res1.status).toBe(200);

    // Second request — same UA, should pass
    const res2 = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'SameAgent/1.0' },
    });
    expect(res2.status).toBe(200);
    const json = await res2.json();
    expect(json.userId).toBe('user-2');
  });

  test('different fingerprint + reject: returns 401', async () => {
    const signing = {
      sessionBinding: { fields: ['ua'], onMismatch: 'reject' } satisfies SessionBindingConfig,
    };
    const app = await buildApp(signing);
    const token = await makeSessionToken('user-3', 'sess-3', signing);

    // First request — stores fingerprint with "AgentA"
    await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentA/1.0' },
    });

    // Second request — different UA
    const res = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentB/2.0' },
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('FINGERPRINT_MISMATCH');
  });

  test('different fingerprint + unauthenticate: returns null userId', async () => {
    const signing = {
      sessionBinding: {
        fields: ['ua'],
        onMismatch: 'unauthenticate',
      } satisfies SessionBindingConfig,
    };
    const app = await buildApp(signing);
    const token = await makeSessionToken('user-4', 'sess-4', signing);

    // First request — stores fingerprint
    await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentA/1.0' },
    });

    // Second request — different UA, should be unauthenticated
    const res = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentB/2.0' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBeNull();
  });

  test('different fingerprint + log-only: allows through', async () => {
    const signing = {
      sessionBinding: { fields: ['ua'], onMismatch: 'log-only' } satisfies SessionBindingConfig,
    };
    const app = await buildApp(signing);
    const token = await makeSessionToken('user-5', 'sess-5', signing);

    // First request — stores fingerprint
    await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentA/1.0' },
    });

    // Second request — different UA, should be allowed through
    const res = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'AgentB/2.0' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBe('user-5');
  });

  test('binding off: setSessionFingerprint is a no-op / not checked', async () => {
    const sessionId = 'sess-6';
    const token = await makeSessionToken('user-6', sessionId);

    // Manually set a fingerprint
    await setSessionFingerprint(sessionRepo, sessionId, 'sha256_of_something');

    const app = await buildApp();
    const res = await app.request('/me', {
      headers: { Cookie: `token=${token}`, 'User-Agent': 'TotallyDifferent/1.0' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBe('user-6'); // fingerprint not checked
  });

  test('getSessionFingerprint stores and retrieves', async () => {
    const sessionId = 'sess-fp-1';
    const token = await makeSessionToken('user-fp', sessionId);
    await setSessionFingerprint(sessionRepo, sessionId, 'test-fingerprint-hash');
    const fp = await getSessionFingerprint(sessionRepo, sessionId);
    expect(fp).toBe('test-fingerprint-hash');
  });

  test('getSessionFingerprint returns null for unknown session', async () => {
    const fp = await getSessionFingerprint(sessionRepo, 'nonexistent-session');
    expect(fp).toBeNull();
  });
});
