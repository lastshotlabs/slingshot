import { describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

describe('rateLimit middleware', () => {
  test('returns 429 when IP rate limit exceeded', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60000, max: 2 },
      },
    });

    await app.request('/');
    await app.request('/');
    const res = await app.request('/');
    expect(res.status).toBe(429);
  });

  test('returns 429 when fingerprint rate limit exceeded', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60000, max: 2, fingerprintLimit: true },
      },
    });

    // Same request fingerprint
    await app.request('/');
    await app.request('/');
    const res = await app.request('/');
    expect(res.status).toBe(429);
  });

  test('keeps framework health routes available after the request budget is exhausted', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60000, max: 1 },
      },
    });

    await app.request('/');
    expect((await app.request('/')).status).toBe(429);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/health/ready')).status).toBe(200);
  });
});
