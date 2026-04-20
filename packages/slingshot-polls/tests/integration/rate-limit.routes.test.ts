import { describe, expect, it } from 'bun:test';
import { createPollsTestApp } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

async function createTestPoll(
  app: { request: (...args: unknown[]) => unknown },
  userId = 'user-1',
): Promise<string> {
  const res = await app.request('/polls/polls', {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify({
      sourceType: 'test:source',
      sourceId: 'src-1',
      scopeId: 'scope-1',
      question: 'Q?',
      options: ['A', 'B'],
    }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('rate limiting', () => {
  it('allows requests within the vote limit', async () => {
    const { app } = await createPollsTestApp({
      rateLimit: { vote: { perUser: { window: '1m', max: 3 } } },
    });
    const pollId = await createTestPoll(app);

    const res = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    expect(res.status).toBe(201);
  });

  it('returns 429 when vote rate limit exceeded', async () => {
    const { app } = await createPollsTestApp({
      rateLimit: { vote: { perUser: { window: '1m', max: 1 } } },
    });

    // Create 2 polls so we can cast separate votes (single-select prevents double vote)
    const pollId1 = await createTestPoll(app);
    const res1 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId: pollId1, optionIndex: 0 }),
    });
    expect(res1.status).toBe(201);

    const pollId2 = await createTestPoll(app);
    const res2 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId: pollId2, optionIndex: 0 }),
    });
    expect(res2.status).toBe(429);

    const body = (await res2.json()) as { error: string; scope: string; op: string };
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.scope).toBe('user');
    expect(body.op).toBe('vote');
    expect(res2.headers.get('Retry-After')).toBeDefined();
    expect(res2.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res2.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('returns 429 when pollCreate rate limit exceeded', async () => {
    const { app } = await createPollsTestApp({
      rateLimit: { pollCreate: { perUser: { window: '1m', max: 1 } } },
    });

    const res1 = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Q?',
        options: ['A', 'B'],
      }),
    });
    expect(res1.status).toBe(201);

    const res2 = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-2',
        scopeId: 'scope-1',
        question: 'Q2?',
        options: ['X', 'Y'],
      }),
    });
    expect(res2.status).toBe(429);
  });

  it('does not rate limit when config is absent', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    // Many requests should all succeed when no rateLimit config
    for (let i = 0; i < 5; i++) {
      const res = await app.request(`/polls/polls/${pollId}`, {
        headers: { 'x-user-id': 'user-1' },
      });
      expect(res.status).toBe(200);
    }
  });

  it('tracks separate users independently', async () => {
    const { app } = await createPollsTestApp({
      rateLimit: { vote: { perUser: { window: '1m', max: 1 } } },
    });
    const pollId = await createTestPoll(app);

    const res1 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    expect(res1.status).toBe(201);

    // Different user should not be rate limited
    const res2 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-2'),
      body: JSON.stringify({ pollId, optionIndex: 1 }),
    });
    expect(res2.status).toBe(201);
  });

  it('returns 429 for results when per-tenant limit exceeded', async () => {
    const { app } = await createPollsTestApp({
      rateLimit: { results: { perTenant: { window: '1m', max: 2 } } },
    });
    const pollId = await createTestPoll(app);

    // Cast a vote so results aren't empty
    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: { ...headers('voter-1'), 'x-tenant-id': 'tenant-1' },
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });

    // First 2 results requests should pass (same tenant)
    for (let i = 0; i < 2; i++) {
      const res = await app.request(`/polls/polls/${pollId}/results`, {
        headers: { 'x-user-id': `user-${i}`, 'x-tenant-id': 'tenant-1' },
      });
      expect(res.status).toBe(200);
    }

    // Third from same tenant should be rate limited
    const res = await app.request(`/polls/polls/${pollId}/results`, {
      headers: { 'x-user-id': 'user-3', 'x-tenant-id': 'tenant-1' },
    });
    expect(res.status).toBe(429);
  });

  it('recovers after window expires', async () => {
    const { app } = await createPollsTestApp({
      // 1-second window
      rateLimit: { pollCreate: { perUser: { window: '1s', max: 1 } } },
    });

    const res1 = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Q?',
        options: ['A', 'B'],
      }),
    });
    expect(res1.status).toBe(201);

    // Should be rate limited
    const res2 = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-2',
        scopeId: 'scope-1',
        question: 'Q2?',
        options: ['A', 'B'],
      }),
    });
    expect(res2.status).toBe(429);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 1100));

    // Should be allowed again
    const res3 = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-3',
        scopeId: 'scope-1',
        question: 'Q3?',
        options: ['A', 'B'],
      }),
    });
    expect(res3.status).toBe(201);
  });
});
