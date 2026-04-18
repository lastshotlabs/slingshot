import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

let handle: E2EServerHandle;

beforeEach(async () => {
  // Very low limit: 3 requests per minute so we can hit it reliably in tests
  handle = await createTestHttpServer({
    security: { rateLimit: { windowMs: 60_000, max: 3 } },
  });
});

afterEach(() => handle.stop());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hitEndpoint(n: number): Promise<Response[]> {
  const results: Response[] = [];
  for (let i = 0; i < n; i++) {
    results.push(await fetch(`${handle.baseUrl}/health`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rate limit enforcement
// ---------------------------------------------------------------------------

describe('rate limiting E2E — /health endpoint', () => {
  test('first 3 requests succeed (200)', async () => {
    const responses = await hitEndpoint(3);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  test('4th request returns 429', async () => {
    // Exhaust the limit
    await hitEndpoint(3);
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
  });

  test('all requests after limit is exceeded return 429', async () => {
    // Exhaust the limit
    await hitEndpoint(3);
    // All subsequent requests should be rate-limited
    const extra1 = await fetch(`${handle.baseUrl}/health`);
    const extra2 = await fetch(`${handle.baseUrl}/health`);
    expect(extra1.status).toBe(429);
    expect(extra2.status).toBe(429);
  });

  test('rate-limited response has non-empty body', async () => {
    await hitEndpoint(3);
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limit on auth endpoint
// ---------------------------------------------------------------------------

describe('rate limiting E2E — /auth/register endpoint', () => {
  test('returns 429 after exceeding limit on POST /auth/register', async () => {
    const post = (body: Record<string, unknown>) =>
      fetch(`${handle.baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // The first few may succeed (201) or fail (400/409) depending on uniqueness,
    // but once the rate limit (3 total) is exhausted, we must get 429.
    await post({ email: 'rl1@example.com', password: 'password123' });
    await post({ email: 'rl2@example.com', password: 'password123' });
    await post({ email: 'rl3@example.com', password: 'password123' });

    // 4th request — limit exceeded
    const res = await post({ email: 'rl4@example.com', password: 'password123' });
    expect(res.status).toBe(429);
  });
});
