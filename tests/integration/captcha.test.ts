import { describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { verifyCaptcha } from '../../src/framework/lib/captcha';
import { requireCaptcha } from '../../src/framework/middleware/captcha';

describe('verifyCaptcha', () => {
  test('returns success when provider returns success:true', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await verifyCaptcha('token123', {
      provider: 'turnstile',
      secretKey: 'secret',
    });

    expect(result.success).toBe(true);
    mockFetch.mockRestore();
  });

  test('returns failure when provider returns success:false', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
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
    mockFetch.mockRestore();
  });

  test('reCAPTCHA v3: fails when score below minScore', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 0.3 }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
      minScore: 0.5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('score-too-low');
    mockFetch.mockRestore();
  });

  test('reCAPTCHA v3: passes when score meets minScore', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 0.8 }), { status: 200 }),
    );

    const result = await verifyCaptcha('token', {
      provider: 'recaptcha',
      secretKey: 'secret',
      minScore: 0.5,
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(0.8);
    mockFetch.mockRestore();
  });

  test('returns failure when provider unreachable', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));

    const result = await verifyCaptcha('token', {
      provider: 'turnstile',
      secretKey: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unreachable');
    mockFetch.mockRestore();
  });
});

describe('requireCaptcha middleware', () => {
  function buildApp() {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400);
      }
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    app.post('/register', requireCaptcha({ provider: 'turnstile', secretKey: 'secret' }), c =>
      c.json({ ok: true }),
    );
    return app;
  }

  test('rejects when token is missing', async () => {
    const app = buildApp();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CAPTCHA_MISSING');
  });

  test('rejects when verification fails', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      }),
    );
    const app = buildApp();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'captcha-token': 'bad' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CAPTCHA_FAILED');
    mockFetch.mockRestore();
  });

  test('passes when verification succeeds', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const app = buildApp();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'captcha-token': 'valid-token' }),
    });
    expect(res.status).toBe(200);
    mockFetch.mockRestore();
  });
});
