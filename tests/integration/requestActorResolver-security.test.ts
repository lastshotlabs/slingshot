import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { afterEach, describe, expect, test } from 'bun:test';
import { signToken, verifyToken } from '@lastshotlabs/slingshot-auth';
import type { RequestActorResolver } from '@lastshotlabs/slingshot-core';
import { sha256 } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

const json = (body: Record<string, unknown>, headers?: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  body: JSON.stringify(body),
});

function getRuntime(app: any): AuthRuntimeContext {
  return (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
}

function getRequestActorResolver(app: any): RequestActorResolver {
  return (app as any).ctx.actorResolver as RequestActorResolver;
}

describe('auth RequestActorResolver upgrade security', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('accepts production __Host-token cookies during upgrade auth', async () => {
    process.env.NODE_ENV = 'production';
    const app = await createTestApp();
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'resolver-host-cookie@example.com', password: 'password123' }),
    );
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    const resolver = getRequestActorResolver(app);

    const actor = await resolver.resolveActor(
      new Request('http://localhost/__ws/chat', {
        headers: { cookie: `__Host-token=${encodeURIComponent(token)}` },
      }),
    );

    expect(actor.kind).toBe('user');
    expect(actor.id).toBe(userId);
  });

  test('accepts x-user-token and Authorization bearer tokens during upgrade auth', async () => {
    const app = await createTestApp();
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'resolver-header-token@example.com', password: 'password123' }),
    );
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    const resolver = getRequestActorResolver(app);

    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__ws/chat', {
            headers: { 'x-user-token': token },
          }),
        )
      ).id,
    ).toBe(userId);
    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__ws/chat', {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).id,
    ).toBe(userId);
  });

  test('resolves M2M bearer tokens as service-account actors during upgrade auth', async () => {
    const app = await createTestApp({}, { auth: { m2m: { tokenExpiry: 3600 } } });
    const runtime = getRuntime(app);
    await runtime.adapter.createM2MClient?.({
      clientId: 'svc-resolver',
      clientSecretHash: 'hash',
      name: 'Resolver service',
      scopes: ['read:data'],
    });
    const token = await signToken(
      { sub: 'svc-resolver', scope: 'read:data' },
      3600,
      runtime.config,
      runtime.signing,
    );
    const resolver = getRequestActorResolver(app);

    const actor = await resolver.resolveActor(
      new Request('http://localhost/__ws/chat', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(actor).toMatchObject({
      id: 'svc-resolver',
      kind: 'service-account',
      sessionId: null,
    });
  });

  test('rejects stale suspended sessions during upgrade auth', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
        },
      },
    );
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'resolver-suspended@example.com', password: 'password123' }),
    );
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    const resolver = getRequestActorResolver(app);
    const runtime = getRuntime(app);

    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__ws/chat', {
            headers: { 'x-user-token': token },
          }),
        )
      ).id,
    ).toBe(userId);

    expect(
      (await resolver.resolveActor(new Request(`http://localhost/__ws/chat?token=${token}`))).id,
    ).toBeNull();

    await runtime.adapter.setSuspended?.(userId, true, 'security hold');

    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__ws/chat', {
            headers: { 'x-user-token': token },
          }),
        )
      ).id,
    ).toBeNull();
  });

  test('rejects stale unverified sessions during upgrade auth', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
          emailVerification: { required: true, tokenExpiry: 3600 },
        },
      },
    );
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'resolver-verify@example.com', password: 'password123' }),
    );
    const { userId } = (await registerRes.json()) as { userId: string };
    const runtime = getRuntime(app);
    await runtime.adapter.setEmailVerified?.(userId, true);

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'resolver-verify@example.com', password: 'password123' }),
    );
    const { token } = (await loginRes.json()) as { token: string };
    const resolver = getRequestActorResolver(app);

    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__sse/feed', {
            headers: { 'x-user-token': token },
          }),
        )
      ).id,
    ).toBe(userId);

    await runtime.adapter.setEmailVerified?.(userId, false);

    expect(
      (
        await resolver.resolveActor(
          new Request('http://localhost/__sse/feed', {
            headers: { 'x-user-token': token },
          }),
        )
      ).id,
    ).toBeNull();
  });

  test('enforces session binding during upgrade auth', async () => {
    const app = await createTestApp({
      security: {
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
          sessionBinding: {
            fields: ['ua'],
            onMismatch: 'unauthenticate',
          },
        },
      },
    });
    const registerRes = await app.request(
      '/auth/register',
      json(
        { email: 'resolver-fingerprint@example.com', password: 'password123' },
        { 'user-agent': 'Browser-A' },
      ),
    );
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    const resolver = getRequestActorResolver(app);
    const runtime = getRuntime(app);
    const payload = await verifyToken(token, runtime.config, runtime.signing);
    await runtime.repos.session.setSessionFingerprint(payload.sid as string, sha256('Browser-A'));

    const matchingReq = new Request('http://localhost/__ws/chat', {
      headers: { 'x-user-token': token, 'user-agent': 'Browser-A' },
    });
    expect((await resolver.resolveActor(matchingReq)).id).toBe(userId);

    const mismatchedReq = new Request('http://localhost/__ws/chat', {
      headers: { 'x-user-token': token, 'user-agent': 'Browser-B' },
    });
    expect((await resolver.resolveActor(mismatchedReq)).id).toBeNull();
  });
});
