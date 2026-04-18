import { csrfProtection } from '@auth/middleware/csrf';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

describe('CSRF middleware reads live signing config', () => {
  it('uses injected signing secret when signing config is passed', async () => {
    const secret = 'injected-csrf-secret-that-is-at-least-32-chars';

    const app = new Hono();
    app.use(csrfProtection({ signing: { secret } }));
    app.get('/test', c => c.text('ok'));

    // GET requests are not CSRF-checked — should pass without error
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('throws when no signing secret is configured', async () => {
    const app = new Hono();
    app.use(csrfProtection());
    app.post('/test', c => c.text('ok'));

    // POST triggers getCsrfSecret() which should throw because nothing is configured
    const res = await app.request('/test', { method: 'POST' });
    // 500 from thrown error (no secret configured), not 403 (invalid token)
    expect(res.status).toBe(500);
  });

  it('no process.env fallback — missing signing config throws on state-changing methods', async () => {
    // Previously this test verified JWT_SECRET env var fallback.
    // With singleton elimination, secrets flow through SigningConfig only.
    const app = new Hono();
    app.use(csrfProtection());
    app.get('/test', c => c.text('ok'));

    // GET still reaches getCsrfSecret → throws → 500
    const res = await app.request('/test');
    expect(res.status).toBe(500);
  });
});
