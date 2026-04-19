import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { signToken } from '@auth/lib/jwt';
import {
  createMemorySessionRepository,
  createSession,
  getMfaVerifiedAt,
  setMfaVerifiedAt,
} from '@auth/lib/session';
import type { SessionRepository } from '@auth/lib/session';
import { createIdentifyMiddleware } from '@auth/middleware/identify';
import { requireStepUp } from '@auth/middleware/requireStepUp';
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';

let sessionRepo: SessionRepository;

beforeEach(() => {
  sessionRepo = createMemorySessionRepository();
});

const TEST_SIGNING = { secret: 'test-secret-key-must-be-at-least-32-chars!!' };

async function makeSessionToken(userId: string, sessionId: string): Promise<string> {
  const token = await signToken(
    { sub: userId, sid: sessionId },
    undefined,
    DEFAULT_AUTH_CONFIG,
    TEST_SIGNING,
  );
  await createSession(sessionRepo, userId, token, sessionId, undefined, DEFAULT_AUTH_CONFIG);
  return token;
}

function buildApp(maxAge?: number) {
  const app = new Hono();
  const emptyAdapter = {};
  const emptyEventBus = { emit() {} };
  const emptyStores = {};
  const runtime = {
    adapter: emptyAdapter as never,
    eventBus: emptyEventBus as never,
    config: DEFAULT_AUTH_CONFIG,
    stores: emptyStores as never,
    signing: { secret: 'test-secret-key-must-be-at-least-32-chars!!' },
    dataEncryptionKeys: [],
    repos: {
      session: sessionRepo,
    },
  };
  app.use('/*', async (c, next) => {
    (c as any).set('slingshotCtx', {
      pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
    });
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.message };
      if (err.code) body.code = err.code;
      return c.json(body, err.status as 401 | 403);
    }
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.use('/*', createIdentifyMiddleware(runtime as any));
  app.get('/sensitive', requireStepUp({ maxAge }), c => c.json({ ok: true }));
  return app;
}

describe('requireStepUp', () => {
  test('blocks when mfaVerifiedAt is not set', async () => {
    const token = await makeSessionToken('user1', 'sess1');
    const app = buildApp();
    const res = await app.request('/sensitive', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('STEP_UP_REQUIRED');
  });

  test('allows when mfaVerifiedAt is recent', async () => {
    const token = await makeSessionToken('user1', 'sess1');
    await setMfaVerifiedAt(sessionRepo, 'sess1');
    const app = buildApp(300);
    const res = await app.request('/sensitive', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
  });

  test('blocks unauthenticated requests', async () => {
    const app = buildApp();
    const res = await app.request('/sensitive');
    expect(res.status).toBe(401);
  });
});

describe('setMfaVerifiedAt / getMfaVerifiedAt', () => {
  test('returns null before setting', async () => {
    await makeSessionToken('u1', 'sess1');
    const result = await getMfaVerifiedAt(sessionRepo, 'sess1');
    expect(result).toBeNull();
  });

  test('returns timestamp after setting', async () => {
    await makeSessionToken('u1', 'sess1');
    const before = Math.floor(Date.now() / 1000);
    await setMfaVerifiedAt(sessionRepo, 'sess1');
    const after = Math.floor(Date.now() / 1000);
    const ts = await getMfaVerifiedAt(sessionRepo, 'sess1');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });
});
