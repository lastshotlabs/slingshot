import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { attachContext } from '@lastshotlabs/slingshot-core';
import { csrfProtection } from '../../packages/slingshot-auth/src/middleware/csrf';
import { createIdentifyMiddleware } from '../../packages/slingshot-auth/src/middleware/identify';

describe('public path aware auth middleware', () => {
  it('identify middleware bypasses auth work for declared public paths', async () => {
    const app = new Hono<AppEnv>();
    const ctxData = {
      publicPaths: new Set(['/.well-known/*']),
    };
    const ctx = ctxData as unknown as never;
    attachContext(app, ctx);

    const emptyRuntimeData = {};
    const emptyRuntime = emptyRuntimeData as unknown as never;
    app.use(createIdentifyMiddleware(emptyRuntime));
    app.get('/.well-known/apple-app-site-association', c =>
      c.json({
        authUserId: c.get('authUserId'),
        roles: c.get('roles'),
        sessionId: c.get('sessionId'),
      }),
    );

    const response = await app.request('/.well-known/apple-app-site-association');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authUserId: null,
      roles: null,
      sessionId: null,
    });
  });

  it('csrf middleware bypasses validation for declared public paths', async () => {
    const app = new Hono<AppEnv>();
    const csrfCtxData = {
      publicPaths: new Set(['/.well-known/*']),
    };
    const csrfCtx = csrfCtxData as unknown as never;
    attachContext(app, csrfCtx);

    app.use(csrfProtection());
    app.post('/.well-known/assetlinks.json', c => c.json({ ok: true }));

    const response = await app.request('/.well-known/assetlinks.json', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
