/**
 * Tests for:
 *   - src/framework/lib/captcha.ts (lines 16-50)
 *   - src/framework/middleware/captcha.ts (lines 14-48)
 */
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { verifyCaptcha } from '../../src/framework/lib/captcha';
import { requireCaptcha } from '../../src/framework/middleware/captcha';

// ---------------------------------------------------------------------------
// verifyCaptcha tests
// ---------------------------------------------------------------------------

function mockFetchOnce(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const replacement = Object.assign(impl, {
    preconnect: globalThis.fetch.preconnect,
  }) satisfies typeof fetch;
  return spyOn(globalThis, 'fetch').mockImplementationOnce(replacement);
}

describe('verifyCaptcha', () => {
  test('returns success: true for hcaptcha success response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await verifyCaptcha('valid-token', {
      provider: 'hcaptcha',
      secretKey: 'secret',
    });

    expect(result.success).toBe(true);
    fetchSpy.mockRestore();
  });

  test('returns success: true for turnstile success response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'turnstile',
      secretKey: 'secret',
    });

    expect(result.success).toBe(true);
    fetchSpy.mockRestore();
  });

  test('returns success: false with error when provider returns failure', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      }),
    );

    const result = await verifyCaptcha('bad-token', {
      provider: 'hcaptcha',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid-input-response');
    fetchSpy.mockRestore();
  });

  test('returns success: false with "invalid-token" when error-codes is empty', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    );

    const result = await verifyCaptcha('bad-token', {
      provider: 'turnstile',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid-token');
    fetchSpy.mockRestore();
  });

  test('returns success: false when provider HTTP response is not ok', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Server Error', { status: 500 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    fetchSpy.mockRestore();
  });

  test('returns success: false when fetch throws (network error)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const result = await verifyCaptcha('token', {
      provider: 'hcaptcha',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('CAPTCHA provider unreachable');
    fetchSpy.mockRestore();
  });

  test('includes ip in POST body when provided', async () => {
    let capturedBody: string | null = null;
    const fetchSpy = mockFetchOnce(async (_url, init) => {
      capturedBody = (init?.body as URLSearchParams).toString();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await verifyCaptcha('token', { provider: 'hcaptcha', secretKey: 'secret' }, '1.2.3.4');

    expect(capturedBody ?? '').toContain('remoteip=1.2.3.4');
    fetchSpy.mockRestore();
  });

  test('does not include remoteip when ip is not provided', async () => {
    let capturedBody: string | null = null;
    const fetchSpy = mockFetchOnce(async (_url, init) => {
      capturedBody = (init?.body as URLSearchParams).toString();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await verifyCaptcha('token', { provider: 'hcaptcha', secretKey: 'secret' });

    expect(capturedBody).not.toContain('remoteip');
    fetchSpy.mockRestore();
  });

  test('recaptcha: returns success: true when score meets minScore', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 0.8 }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
      minScore: 0.5,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(0.8);
    fetchSpy.mockRestore();
  });

  test('recaptcha: returns success: false when score below minScore', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 0.2 }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
      minScore: 0.5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('score-too-low');
    expect(result.score).toBe(0.2);
    fetchSpy.mockRestore();
  });

  test('recaptcha: uses default minScore of 0.5 when not specified', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 0.3 }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('score-too-low');
    fetchSpy.mockRestore();
  });

  test('calls recaptcha verify URL', async () => {
    let calledUrl: string | null = null;
    const fetchSpy = mockFetchOnce(async url => {
      calledUrl = url as string;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await verifyCaptcha('token', { provider: 'recaptcha', secretKey: 'secret' });

    expect(calledUrl ?? '').toBe('https://www.google.com/recaptcha/api/siteverify');
    fetchSpy.mockRestore();
  });

  test('calls hcaptcha verify URL', async () => {
    let calledUrl: string | null = null;
    const fetchSpy = mockFetchOnce(async url => {
      calledUrl = url as string;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await verifyCaptcha('token', { provider: 'hcaptcha', secretKey: 'secret' });

    expect(calledUrl ?? '').toBe('https://hcaptcha.com/siteverify');
    fetchSpy.mockRestore();
  });

  test('calls turnstile verify URL', async () => {
    let calledUrl: string | null = null;
    const fetchSpy = mockFetchOnce(async url => {
      calledUrl = url as string;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await verifyCaptcha('token', { provider: 'turnstile', secretKey: 'secret' });

    expect(calledUrl ?? '').toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// requireCaptcha middleware tests
// ---------------------------------------------------------------------------

function makeMiddlewareContext(
  overrides: {
    body?: Record<string, unknown>;
    slingshotCtx?: object | null;
    method?: string;
  } = {},
) {
  const { body = {}, slingshotCtx = null, method = 'POST' } = overrides;

  const store = new Map<string, unknown>();
  if (slingshotCtx !== null) {
    store.set('slingshotCtx', slingshotCtx);
  }

  return {
    req: {
      method,
      path: '/test',
      header: () => undefined,
      json: async () => body,
      raw: new Request('http://localhost/test', { method }),
    },
    res: { status: 200 },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    json: mock(() => new Response()),
    header: mock(() => {}),
  } as any;
}

describe('requireCaptcha middleware', () => {
  test('calls next() when no config is provided and no context config', async () => {
    const middleware = requireCaptcha();
    const ctx = makeMiddlewareContext({ slingshotCtx: null });

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('calls next() when slingshotCtx has no captcha config', async () => {
    const middleware = requireCaptcha();
    const ctx = makeMiddlewareContext({
      slingshotCtx: { app: { __dummy: true } }, // app without captcha config
    });

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('throws 400 CAPTCHA_MISSING when token is absent', async () => {
    const middleware = requireCaptcha({ provider: 'hcaptcha', secretKey: 'secret' });
    const ctx = makeMiddlewareContext({ body: {} }); // no token field

    await expect(middleware(ctx, async () => {})).rejects.toMatchObject({
      status: 400,
      code: 'CAPTCHA_MISSING',
    });
  });

  test('throws 400 CAPTCHA_MISSING when custom tokenField is absent', async () => {
    const middleware = requireCaptcha({
      provider: 'hcaptcha',
      secretKey: 'secret',
      tokenField: 'h-captcha-response',
    });
    const ctx = makeMiddlewareContext({ body: { 'captcha-token': 'wrong-field' } });

    await expect(middleware(ctx, async () => {})).rejects.toMatchObject({
      status: 400,
      code: 'CAPTCHA_MISSING',
    });
  });

  test('throws 400 CAPTCHA_FAILED when verification fails', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-token'] }), {
        status: 200,
      }),
    );

    const middleware = requireCaptcha({ provider: 'hcaptcha', secretKey: 'secret' });
    const ctx = makeMiddlewareContext({ body: { 'captcha-token': 'bad-token' } });

    await expect(middleware(ctx, async () => {})).rejects.toMatchObject({
      status: 400,
      code: 'CAPTCHA_FAILED',
    });

    fetchSpy.mockRestore();
  });

  test('calls next() when verification succeeds', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const middleware = requireCaptcha({ provider: 'hcaptcha', secretKey: 'secret' });
    const ctx = makeMiddlewareContext({ body: { 'captcha-token': 'good-token' } });

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    fetchSpy.mockRestore();
  });

  test('uses custom tokenField from config', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const middleware = requireCaptcha({
      provider: 'turnstile',
      secretKey: 'secret',
      tokenField: 'cf-turnstile-response',
    });
    const ctx = makeMiddlewareContext({
      body: { 'cf-turnstile-response': 'my-token' },
    });

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    fetchSpy.mockRestore();
  });

  test('treats empty body as missing token (JSON parse failure)', async () => {
    const middleware = requireCaptcha({ provider: 'hcaptcha', secretKey: 'secret' });

    // Simulate body parse error: json() throws
    const ctx = makeMiddlewareContext({});
    ctx.req.json = async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    };

    // With empty body (parse error), body={}, so token is missing → 400 CAPTCHA_MISSING
    await expect(middleware(ctx, async () => {})).rejects.toMatchObject({
      status: 400,
      code: 'CAPTCHA_MISSING',
    });
  });
});
