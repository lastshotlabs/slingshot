import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'bun:test';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Setup: app with email verification enabled + /protected/verified fixture route
// ---------------------------------------------------------------------------

describe('requireVerifiedEmail middleware', () => {
  let app: OpenAPIHono<any>;
  const getRuntime = (targetApp: object) => getAuthRuntimeContext(getContext(targetApp));

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false, // required:false means verification is optional for login, but enforced by middleware
          },
        },
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated request
  // ---------------------------------------------------------------------------

  it('returns 401 when no token is provided (via userAuth)', async () => {
    const res = await app.request('/protected/verified');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 401 from requireVerifiedEmail itself when userId is null', async () => {
    // /protected/verified-no-auth uses requireVerifiedEmail WITHOUT userAuth,
    // so the 401 comes from requireVerifiedEmail's own null-userId check (line 17)
    const res = await app.request('/protected/verified-no-auth');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  // ---------------------------------------------------------------------------
  // Authenticated but email not verified
  // ---------------------------------------------------------------------------

  it("returns 403 when authenticated user's email is not verified", async () => {
    const reg = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unverified@test.com', password: 'password123' }),
    });
    expect(reg.status).toBe(201);
    const { token } = await reg.json();

    // Email is not verified after registration (emailVerification.required: false)
    const res = await app.request('/protected/verified', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/email not verified/i);
  });

  // ---------------------------------------------------------------------------
  // Authenticated with verified email
  // ---------------------------------------------------------------------------

  it("returns 200 when authenticated user's email is verified", async () => {
    const reg = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verified@test.com', password: 'password123' }),
    });
    expect(reg.status).toBe(201);
    const { token, userId } = await reg.json();

    // Directly mark email as verified via the adapter
    const adapter = getRuntime(app).adapter;
    await adapter.setEmailVerified!(userId, true);

    const res = await app.request('/protected/verified', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Full verification token flow
  // ---------------------------------------------------------------------------

  it('allows access after completing the email verification token flow', async () => {
    let capturedToken = '';

    // Create a fresh app that captures the verification token
    const appWithCapture = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false,
          },
        },
      },
    );

    // Register listener AFTER createTestApp so we get the bus set by the plugin
    const evHandler = (payload: { token: string }) => {
      capturedToken = payload.token;
    };
    getRuntime(appWithCapture).eventBus.on('auth:delivery.email_verification', evHandler);

    const reg = await appWithCapture.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'flow@test.com', password: 'password123' }),
    });
    const { token: jwt } = await reg.json();

    // Use the verification token
    const verifyRes = await appWithCapture.request('/auth/verify-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-token': jwt,
      },
      body: JSON.stringify({ token: capturedToken }),
    });
    expect(verifyRes.status).toBe(200);

    // Now the protected route should be accessible
    const res = await appWithCapture.request('/protected/verified', {
      headers: { 'x-user-token': jwt },
    });
    getRuntime(appWithCapture).eventBus.off('auth:delivery.email_verification', evHandler);
    expect(res.status).toBe(200);
  });
});
