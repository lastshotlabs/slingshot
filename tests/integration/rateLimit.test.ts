import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

describe('rateLimit middleware', () => {
  test('returns 429 when IP rate limit exceeded', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60000, max: 2 },
      },
    });

    await app.request('/health');
    await app.request('/health');
    const res = await app.request('/health');
    expect(res.status).toBe(429);
  });

  test('returns 429 when fingerprint rate limit exceeded', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60000, max: 2, fingerprintLimit: true },
      },
    });

    // Same request fingerprint
    await app.request('/health');
    await app.request('/health');
    const res = await app.request('/health');
    expect(res.status).toBe(429);
  });
});
