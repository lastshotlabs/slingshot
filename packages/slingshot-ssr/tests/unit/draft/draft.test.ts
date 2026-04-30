// tests/unit/draft/draft.test.ts
// Unit tests for the slingshot-ssr draft mode module.
//
// Covers:
// - DRAFT_MODE_COOKIE constant value
// - isDraftRequest() — reads cookie from Hono context
// - withDraftContext() — stores Hono context in AsyncLocalStorage
// - draftMode().isEnabled — reads from the stored context
// - draftMode().enable() — sets the draft cookie on the response
// - draftMode().disable() — clears the draft cookie on the response
// - draftMode() outside context — throws descriptive error
// - buildDraftRouter() — enable endpoint validates secret
// - buildDraftRouter() — disable endpoint clears cookie
// - buildDraftRouter() — enable endpoint rejects wrong secret
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  DRAFT_MODE_COOKIE,
  draftMode,
  isDraftRequest,
  withDraftContext,
} from '../../../src/draft/index';
import { buildDraftRouter } from '../../../src/draft/routes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Hono context with optional cookie header.
 *
 * We create a real Hono app, register a single route that captures its context,
 * and fire a fetch to get back a real Hono `Context` object.
 */
async function buildHonoContext(cookie?: string): Promise<import('hono').Context> {
  let captured: import('hono').Context | undefined;
  const app = new Hono();
  app.get('/test', c => {
    captured = c;
    return c.text('ok');
  });
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  await app.fetch(new Request('http://localhost/test', { headers }));
  if (!captured) throw new Error('Context not captured');
  return captured;
}

// ─── DRAFT_MODE_COOKIE ────────────────────────────────────────────────────────

describe('DRAFT_MODE_COOKIE', () => {
  it('has the expected value', () => {
    expect(DRAFT_MODE_COOKIE).toBe('__slingshot_draft__');
  });
});

// ─── isDraftRequest() ─────────────────────────────────────────────────────────

describe('isDraftRequest()', () => {
  it('returns false when no cookie is present', async () => {
    const c = await buildHonoContext();
    expect(isDraftRequest(c)).toBe(false);
  });

  it('returns false when cookie is present but empty', async () => {
    const c = await buildHonoContext(`${DRAFT_MODE_COOKIE}=`);
    expect(isDraftRequest(c)).toBe(false);
  });

  it('returns true when cookie has a non-empty value', async () => {
    const c = await buildHonoContext(`${DRAFT_MODE_COOKIE}=1`);
    expect(isDraftRequest(c)).toBe(true);
  });

  it('returns false when a different cookie is present', async () => {
    const c = await buildHonoContext('other_cookie=abc');
    expect(isDraftRequest(c)).toBe(false);
  });

  it('returns true with multiple cookies when draft cookie is present', async () => {
    const c = await buildHonoContext(`session=xyz; ${DRAFT_MODE_COOKIE}=1; other=foo`);
    expect(isDraftRequest(c)).toBe(true);
  });
});

// ─── withDraftContext() / draftMode() ─────────────────────────────────────────

describe('draftMode()', () => {
  it('throws when called outside a draft context', () => {
    expect(() => draftMode()).toThrow(
      '[slingshot-ssr] draftMode() called outside of a draft context',
    );
  });

  it('isEnabled returns false when no draft cookie on request', async () => {
    const c = await buildHonoContext();
    const result = await withDraftContext(c, async () => draftMode().isEnabled);
    expect(result).toBe(false);
  });

  it('isEnabled returns true when draft cookie is present', async () => {
    const c = await buildHonoContext(`${DRAFT_MODE_COOKIE}=1`);
    const result = await withDraftContext(c, async () => draftMode().isEnabled);
    expect(result).toBe(true);
  });

  it('enable() sets the draft cookie on the response', async () => {
    const app = new Hono();
    app.get('/test', async c => {
      return withDraftContext(c, async () => {
        draftMode().enable();
        return c.text('enabled');
      });
    });

    const response = await app.fetch(new Request('http://localhost/test'));
    expect(response.status).toBe(200);
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(DRAFT_MODE_COOKIE);
    expect(setCookieHeader).toContain('1');
    expect(setCookieHeader.toLowerCase()).toContain('httponly');
    expect(setCookieHeader.toLowerCase()).toContain('samesite=lax');
    expect(setCookieHeader.toLowerCase()).toContain('path=/');
  });

  it('disable() removes the draft cookie', async () => {
    const app = new Hono();
    app.get('/test', async c => {
      return withDraftContext(c, async () => {
        draftMode().disable();
        return c.text('disabled');
      });
    });

    const response = await app.fetch(
      new Request('http://localhost/test', {
        headers: { cookie: `${DRAFT_MODE_COOKIE}=1` },
      }),
    );
    expect(response.status).toBe(200);
    // After disable(), the cookie should be expired or cleared
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(DRAFT_MODE_COOKIE);
    // Hono's deleteCookie sets expires in the past or max-age=0
    const isCleared =
      setCookieHeader.toLowerCase().includes('max-age=0') ||
      setCookieHeader.toLowerCase().includes('expires=');
    expect(isCleared).toBe(true);
  });

  it('isEnabled reflects updated state when enable() is called', async () => {
    const app = new Hono();
    let wasEnabled = false;
    app.get('/test', async c => {
      return withDraftContext(c, async () => {
        wasEnabled = draftMode().isEnabled;
        draftMode().enable();
        return c.text('ok');
      });
    });

    // Request without draft cookie — isEnabled should be false before enable()
    await app.fetch(new Request('http://localhost/test'));
    expect(wasEnabled).toBe(false);
  });
});

// ─── buildDraftRouter() ───────────────────────────────────────────────────────

describe('buildDraftRouter()', () => {
  const SECRET = 'super-secret-token-123';

  it('enable returns 401 when secret is missing', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('enable rejects GET requests without setting draft mode', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(new Request('http://localhost/api/draft/enable'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('enable returns 401 when secret is wrong', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable', {
        method: 'POST',
        headers: { 'x-draft-mode-secret': 'wrong-secret' },
      }),
    );
    expect(response.status).toBe(401);
  });

  it('enable rejects secrets in the URL', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request(`http://localhost/api/draft/enable?secret=${SECRET}`),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Draft mode secret must not be sent in the URL');
  });

  it('enable sets draft cookie and redirects to / by default', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable', {
        method: 'POST',
        headers: { 'x-draft-mode-secret': SECRET },
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(DRAFT_MODE_COOKIE);
  });

  it('enable redirects to provided ?redirect path', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable?redirect=/posts/draft-post', {
        method: 'POST',
        headers: { 'x-draft-mode-secret': SECRET },
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/posts/draft-post');
  });

  it('enable sanitises non-relative redirect to /', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable?redirect=https://evil.com', {
        method: 'POST',
        headers: { 'x-draft-mode-secret': SECRET },
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
  });

  it('enable accepts the secret from a JSON request body', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/enable?redirect=/posts/draft-post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: SECRET }),
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/posts/draft-post');
  });

  it('disable clears the draft cookie and redirects to /', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/disable', {
        headers: { cookie: `${DRAFT_MODE_COOKIE}=1` },
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    // Cookie should be cleared
    expect(setCookieHeader).toContain(DRAFT_MODE_COOKIE);
    const isCleared =
      setCookieHeader.toLowerCase().includes('max-age=0') ||
      setCookieHeader.toLowerCase().includes('expires=');
    expect(isCleared).toBe(true);
  });

  it('disable redirects to provided ?redirect path', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    const response = await app.fetch(
      new Request('http://localhost/api/draft/disable?redirect=/posts'),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/posts');
  });

  it('disable does not require a secret', async () => {
    const app = new Hono();
    app.route('/api/draft', buildDraftRouter(SECRET));

    // No secret provided — should succeed
    const response = await app.fetch(new Request('http://localhost/api/draft/disable'), {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
  });
});
