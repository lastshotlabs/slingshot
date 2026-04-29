import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { AUTH_RUNTIME_KEY } from '@lastshotlabs/slingshot-auth/testing';
import type { AppEnv, SlingshotContext } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { requireScope } from '../src/middleware/requireScope';

function makeRuntime(opts?: {
  active?: boolean;
  clientScopes?: string[];
  serverScopes?: string[];
  recheckClientOnUse?: boolean;
}): AuthRuntimeContext {
  return {
    adapter: {
      getM2MClient: async () =>
        opts?.active === false
          ? null
          : {
              id: 'm2m-1',
              clientId: 'svc-1',
              name: 'Service',
              scopes: opts?.clientScopes ?? ['read:data', 'write:data'],
              active: true,
              clientSecretHash: 'hash',
            },
    },
    config: {
      m2m: {
        scopes: opts?.serverScopes,
        recheckClientOnUse: opts?.recheckClientOnUse,
      },
    },
  } as unknown as AuthRuntimeContext;
}

function buildApp(opts: {
  actorKind: 'anonymous' | 'user' | 'service-account';
  scope?: string;
  runtime?: AuthRuntimeContext;
}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (opts.runtime) {
      c.set('slingshotCtx', {
        pluginState: new Map([[AUTH_RUNTIME_KEY, opts.runtime]]),
      } as SlingshotContext);
    }
    const kind = opts.actorKind;
    c.set(
      'actor',
      Object.freeze({
        id: kind === 'anonymous' ? null : 'svc-1',
        kind,
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      }),
    );
    if (opts.scope !== undefined) {
      c.set('tokenPayload', { scope: opts.scope });
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code }, err.status as 401);
    }
    return c.json({ error: err.message }, 500);
  });

  return app;
}

describe('requireScope', () => {
  test('rejects anonymous actors with 401', async () => {
    const app = buildApp({ actorKind: 'anonymous' });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Authentication required' });
  });

  test('rejects non-service-account actors with 403 M2M_REQUIRED', async () => {
    const app = buildApp({ actorKind: 'user' });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'M2M_REQUIRED' });
  });

  test('rejects service-account with missing scope claim with 403 INSUFFICIENT_SCOPE', async () => {
    const app = buildApp({ actorKind: 'service-account' }); // no tokenPayload set
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  test('rejects service-account when scope claim is not a string', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set(
        'actor',
        Object.freeze({
          id: 'svc-1',
          kind: 'service-account',
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      c.set('tokenPayload', { scope: 42 }); // non-string
      await next();
    });
    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ code: err.code }, err.status as 401);
      return c.json({}, 500);
    });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  test('rejects service-account missing a required scope', async () => {
    const app = buildApp({ actorKind: 'service-account', scope: 'read:data' });
    app.get('/api', requireScope('read:data', 'write:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  test('allows service-account with all required scopes', async () => {
    const app = buildApp({
      actorKind: 'service-account',
      scope: 'read:data write:data',
      runtime: makeRuntime(),
    });
    app.get('/api', requireScope('read:data', 'write:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('rejects service-account when client was disabled after token issue', async () => {
    const app = buildApp({
      actorKind: 'service-account',
      scope: 'read:data',
      runtime: makeRuntime({ active: false }),
    });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'M2M_CLIENT_INACTIVE' });
  });

  test('rejects service-account when client scopes were narrowed after token issue', async () => {
    const app = buildApp({
      actorKind: 'service-account',
      scope: 'read:data write:data',
      runtime: makeRuntime({ clientScopes: ['read:data'] }),
    });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  test('rejects service-account when server scopes were narrowed after token issue', async () => {
    const app = buildApp({
      actorKind: 'service-account',
      scope: 'read:data write:data',
      runtime: makeRuntime({ serverScopes: ['read:data'] }),
    });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  test('scope check is exact — partial token name does not satisfy a longer scope', async () => {
    const app = buildApp({ actorKind: 'service-account', scope: 'read' });
    app.get('/api', requireScope('read:data'), c => c.json({ ok: true }));

    const res = await app.request('/api');
    expect(res.status).toBe(403);
  });
});
