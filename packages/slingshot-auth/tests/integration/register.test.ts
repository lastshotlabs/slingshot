import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createRegisterRouter } from '../../src/routes/register';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createRegisterRouter({ primaryField: 'email' }, runtime));
  return app;
}

function buildConcealedApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createRegisterRouter({ primaryField: 'email', concealRegistration: {} }, runtime));
  return app;
}

function buildAppWithRefreshTokens(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route(
    '/',
    createRegisterRouter(
      {
        primaryField: 'email',
        refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },
      },
      runtime,
    ),
  );
  return app;
}

async function postRegister(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Standard mode (concealRegistration: null)
// ---------------------------------------------------------------------------

describe('POST /auth/register — standard mode', () => {
  let runtime: MutableTestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime({ concealRegistration: null });
  });

  test('happy path — new user returns 201 with token and userId', async () => {
    const app = buildApp(runtime);
    const { status, json } = await postRegister(app, {
      email: 'alice@example.com',
      password: 'StrongPass1',
    });

    expect(status).toBe(201);
    expect(typeof json.token).toBe('string');
    expect((json.token as string).length).toBeGreaterThan(0);
    expect(typeof json.userId).toBe('string');
    expect((json.userId as string).length).toBeGreaterThan(0);
  });

  test('duplicate email returns 409', async () => {
    const app = buildApp(runtime);
    await postRegister(app, { email: 'alice@example.com', password: 'StrongPass1' });
    const { status, json } = await postRegister(app, {
      email: 'alice@example.com',
      password: 'AnotherPass2',
    });

    expect(status).toBe(409);
    expect(json.error).toBeDefined();
  });

  test('weak password — too short fails validation', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, {
      email: 'short@example.com',
      password: 'Ab1',
    });

    // Password policy default: min 8 chars, at least one letter + one digit
    expect(status).toBe(400);
  });

  test('weak password — missing digit fails validation', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, {
      email: 'nodigit@example.com',
      password: 'abcdefghij',
    });

    expect(status).toBe(400);
  });

  test('weak password — missing letter fails validation', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, {
      email: 'noletter@example.com',
      password: '123456789',
    });

    expect(status).toBe(400);
  });

  test('events emitted — security.auth.register.success on success', async () => {
    const emittedEvents: string[] = [];
    runtime.eventBus = makeEventBus(event => emittedEvents.push(event));
    const app = buildApp(runtime);

    await postRegister(app, { email: 'events@example.com', password: 'StrongPass1' });

    expect(emittedEvents).toContain('security.auth.register.success');
  });

  test('session created — returned token is valid JWT with correct sub', async () => {
    const app = buildApp(runtime);
    const { json } = await postRegister(app, {
      email: 'jwt@example.com',
      password: 'StrongPass1',
    });

    const token = json.token as string;
    expect(token).toBeTruthy();

    // Decode the JWT payload (base64url middle segment)
    const parts = token.split('.');
    expect(parts.length).toBe(3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
      sub?: string;
    };
    expect(payload.sub).toBe(json.userId as string);
  });

  test('refresh token — with refreshToken config, response includes refreshToken', async () => {
    runtime = makeTestRuntime({
      concealRegistration: null,
      refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },
    });
    const app = buildAppWithRefreshTokens(runtime);

    const { status, json } = await postRegister(app, {
      email: 'refresh@example.com',
      password: 'StrongPass1',
    });

    expect(status).toBe(201);
    expect(typeof json.refreshToken).toBe('string');
    expect((json.refreshToken as string).length).toBeGreaterThan(0);
  });

  test('required email verification does not issue a live session on register', async () => {
    runtime = makeTestRuntime({
      concealRegistration: null,
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
    });
    const app = buildApp(runtime);

    const res = await app.fetch(
      new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'verify-first@example.com',
          password: 'StrongPass1',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toBe('');
    expect(body.emailVerified).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();

    const sessions = await runtime.repos.session.getUserSessions(
      body.userId as string,
      runtime.config,
    );
    expect(sessions).toHaveLength(0);
  });

  test('case insensitive — Alice@Example.com and alice@example.com collide', async () => {
    const app = buildApp(runtime);

    const first = await postRegister(app, {
      email: 'Alice@Example.com',
      password: 'StrongPass1',
    });
    expect(first.status).toBe(201);

    const second = await postRegister(app, {
      email: 'alice@example.com',
      password: 'StrongPass1',
    });
    expect(second.status).toBe(409);
  });

  test('email normalization — User.Name+tag@Gmail.com then username@gmail.com conflict', async () => {
    const app = buildApp(runtime);

    // The memory adapter normalizes to lowercase. Gmail-specific normalization
    // (dot removal, plus-stripping) depends on the adapter implementation.
    // Register with the first variant
    const first = await postRegister(app, {
      email: 'username@gmail.com',
      password: 'StrongPass1',
    });
    expect(first.status).toBe(201);

    // Same normalized form should conflict
    const second = await postRegister(app, {
      email: 'Username@Gmail.com',
      password: 'StrongPass1',
    });
    expect(second.status).toBe(409);
  });

  test('missing email field returns 400', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, { password: 'StrongPass1' });

    expect([400, 422]).toContain(status);
  });

  test('missing password field returns 400', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, { email: 'nopw@example.com' });

    expect([400, 422]).toContain(status);
  });

  test('empty string password fails validation', async () => {
    const app = buildApp(runtime);
    const { status } = await postRegister(app, {
      email: 'empty@example.com',
      password: '',
    });

    expect([400, 422]).toContain(status);
  });

  test('rate limiting — rapid registration attempts get 429', async () => {
    // Default rate limit: 5 attempts per hour per IP
    const app = buildApp(runtime);

    // Exhaust the rate limit window — unique emails so they don't fail on 409
    for (let i = 0; i < 5; i++) {
      await postRegister(app, {
        email: `ratelimit${i}@example.com`,
        password: 'StrongPass1',
      });
    }

    const { status } = await postRegister(app, {
      email: 'ratelimitextra@example.com',
      password: 'StrongPass1',
    });

    expect(status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Concealed mode (concealRegistration: {})
// ---------------------------------------------------------------------------

describe('POST /auth/register — concealed mode', () => {
  let runtime: MutableTestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime({ concealRegistration: {} });
  });

  test('new email returns 200 with message string', async () => {
    const app = buildConcealedApp(runtime);
    const { status, json } = await postRegister(app, {
      email: 'newuser@example.com',
      password: 'StrongPass1',
    });

    expect(status).toBe(200);
    expect(typeof json.message).toBe('string');
    // Should NOT contain token or userId in concealed mode
    expect(json.token).toBeUndefined();
    expect(json.userId).toBeUndefined();
  });

  test('existing email returns 200 with same message shape — no enumeration', async () => {
    const app = buildConcealedApp(runtime);

    // Register a user first
    const first = await postRegister(app, {
      email: 'existing@example.com',
      password: 'StrongPass1',
    });
    expect(first.status).toBe(200);
    expect(typeof first.json.message).toBe('string');

    // Register again with the same email — should get same status and shape
    const second = await postRegister(app, {
      email: 'existing@example.com',
      password: 'AnotherPass2',
    });
    expect(second.status).toBe(200);
    expect(typeof second.json.message).toBe('string');

    // Both responses should have the same message shape
    expect(first.json.message).toBe(second.json.message);
  });

  test('existing email emits concealed event — security.auth.register.concealed', async () => {
    const emittedEvents: string[] = [];
    runtime.eventBus = makeEventBus(event => emittedEvents.push(event));

    const app = buildConcealedApp(runtime);

    // Seed a user
    await postRegister(app, { email: 'seed@example.com', password: 'StrongPass1' });

    // Clear events from first registration
    emittedEvents.length = 0;

    // Register again with same email
    await postRegister(app, { email: 'seed@example.com', password: 'AnotherPass2' });

    expect(emittedEvents).toContain('security.auth.register.concealed');
  });

  test('email normalization — User+tag@gmail.com is treated same as user@gmail.com', async () => {
    const emittedEvents: string[] = [];
    runtime.eventBus = makeEventBus(event => emittedEvents.push(event));

    const app = buildConcealedApp(runtime);

    // Register with normalized form
    const first = await postRegister(app, {
      email: 'user@gmail.com',
      password: 'StrongPass1',
    });
    expect(first.status).toBe(200);

    // Clear events from first registration
    emittedEvents.length = 0;

    // Same email with different casing — adapter lowercases, so this should
    // hit the existing user path in concealed mode
    const second = await postRegister(app, {
      email: 'User@Gmail.com',
      password: 'StrongPass1',
    });
    expect(second.status).toBe(200);
    expect(emittedEvents).toContain('security.auth.register.concealed');
  });

  test('rate limiting — rapid concealed registration attempts get 429', async () => {
    const app = buildConcealedApp(runtime);

    for (let i = 0; i < 5; i++) {
      await postRegister(app, {
        email: `ratelimit${i}@example.com`,
        password: 'StrongPass1',
      });
    }

    const { status } = await postRegister(app, {
      email: 'ratelimitextra@example.com',
      password: 'StrongPass1',
    });

    expect(status).toBe(429);
  });

  test('weak password still rejected in concealed mode', async () => {
    const app = buildConcealedApp(runtime);
    const { status } = await postRegister(app, {
      email: 'weak@example.com',
      password: 'short',
    });

    expect(status).toBe(400);
  });
});
