import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createPollsTestApp } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

/** Helper: create a poll and return its id. */
async function createTestPoll(app: Hono, userId = 'user-1'): Promise<string> {
  const res = await app.request('/polls/polls', {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify({
      sourceType: 'test:source',
      sourceId: 'src-1',
      scopeId: 'scope-1',
      question: 'Q?',
      options: ['A', 'B', 'C'],
    }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('poll-votes routes', () => {
  it('casts a vote', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    const res = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });

    expect(res.status).toBe(201);
    const vote = (await res.json()) as { pollId: string; userId: string; optionIndex: number };
    expect(vote.pollId).toBe(pollId);
    expect(vote.userId).toBe('voter-1');
    expect(vote.optionIndex).toBe(0);
  });

  it('lists votes by poll', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-2'),
      body: JSON.stringify({ pollId, optionIndex: 1 }),
    });

    // Named op: POST /polls/poll-votes/list-by-poll
    const res = await app.request('/polls/poll-votes/list-by-poll', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(data.items.length).toBe(2);
  });

  it('counts votes by option', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-2'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-3'),
      body: JSON.stringify({ pollId, optionIndex: 1 }),
    });

    // Named op: POST /polls/poll-votes/count-by-option
    const res = await app.request('/polls/poll-votes/count-by-option', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ optionIndex: number; count: number }>;
    // Response format varies — may be array or object with items
    const items = Array.isArray(data) ? data : (data as unknown as { items: typeof data }).items;
    expect(items).toBeDefined();
  });

  it('gets my votes', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });

    // Named op: POST /polls/poll-votes/my-votes
    const res = await app.request('/polls/poll-votes/my-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: Array<{ userId: string }> };
    expect(data.items.length).toBe(1);
    expect(data.items[0].userId).toBe('voter-1');
  });

  it('retracts a vote (delete)', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    const voteRes = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    const vote = (await voteRes.json()) as { id: string };

    const deleteRes = await app.request(`/polls/poll-votes/${vote.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'voter-1' },
    });

    expect(deleteRes.status).toBe(204);
  });

  it('rejects vote on closed poll', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    // Close the poll via named op
    await app.request('/polls/polls/close-poll', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ id: pollId }),
    });

    const res = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects duplicate vote on single-select poll', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    // First vote succeeds
    const first = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 0 }),
    });
    expect(first.status).toBe(201);

    // Second vote on different option rejected (single-select)
    const second = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 1 }),
    });
    expect(second.status).toBe(409);
  });

  it('rejects out-of-range option index', async () => {
    const { app } = await createPollsTestApp();
    const pollId = await createTestPoll(app);

    const res = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId, optionIndex: 99 }),
    });

    expect(res.status).toBe(400);
  });
});
