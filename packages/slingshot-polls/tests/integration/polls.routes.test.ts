import { describe, expect, it } from 'bun:test';
import { createPollsTestApp } from '../../src/testing';

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('polls routes — full CRUD lifecycle', () => {
  it('creates a poll', async () => {
    const { app } = await createPollsTestApp();

    const res = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Favorite color?',
        options: ['Red', 'Blue', 'Green'],
      }),
    });

    expect(res.status).toBe(201);
    const poll = (await res.json()) as { id: string; question: string; authorId: string };
    expect(poll.id).toBeDefined();
    expect(poll.question).toBe('Favorite color?');
    expect(poll.authorId).toBe('user-1');
  });

  it('gets a poll by id', async () => {
    const { app } = await createPollsTestApp();

    const createRes = await app.request('/polls/polls', {
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
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/polls/polls/${created.id}`, {
      headers: { 'x-user-id': 'user-1' },
    });

    expect(res.status).toBe(200);
    const poll = (await res.json()) as { id: string; question: string };
    expect(poll.id).toBe(created.id);
    expect(poll.question).toBe('Q?');
  });

  it('lists polls', async () => {
    const { app } = await createPollsTestApp();

    // Create two polls
    for (const q of ['Q1?', 'Q2?']) {
      await app.request('/polls/polls', {
        method: 'POST',
        headers: headers('user-1'),
        body: JSON.stringify({
          sourceType: 'test:source',
          sourceId: 'src-1',
          scopeId: 'scope-1',
          question: q,
          options: ['A', 'B'],
        }),
      });
    }

    const res = await app.request('/polls/polls', {
      headers: { 'x-user-id': 'user-1' },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(data.items.length).toBe(2);
  });

  it('lists polls by source', async () => {
    const { app } = await createPollsTestApp();

    await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-A',
        scopeId: 'scope-1',
        question: 'Q1?',
        options: ['A', 'B'],
      }),
    });
    await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-B',
        scopeId: 'scope-1',
        question: 'Q2?',
        options: ['A', 'B'],
      }),
    });

    // Named op: POST /polls/polls/list-by-source
    const res = await app.request('/polls/polls/list-by-source', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ sourceType: 'test:source', sourceId: 'src-A' }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: Array<{ sourceId: string }> };
    expect(data.items.length).toBe(1);
    expect(data.items[0].sourceId).toBe('src-A');
  });

  it('closes a poll', async () => {
    const { app } = await createPollsTestApp();

    const createRes = await app.request('/polls/polls', {
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
    const created = (await createRes.json()) as { id: string };

    // Named op: POST /polls/polls/close-poll with id in body
    const closeRes = await app.request('/polls/polls/close-poll', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ id: created.id }),
    });

    expect(closeRes.status).toBe(200);
    const closed = (await closeRes.json()) as { closed: boolean; closedBy: string };
    expect(closed.closed).toBe(true);
    expect(closed.closedBy).toBe('user-1');
  });

  it('deletes a poll', async () => {
    const { app } = await createPollsTestApp();

    const createRes = await app.request('/polls/polls', {
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
    const created = (await createRes.json()) as { id: string };

    const deleteRes = await app.request(`/polls/polls/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });

    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const getRes = await app.request(`/polls/polls/${created.id}`, {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(getRes.status).toBe(404);
  });

  it('gets poll results', async () => {
    const { app } = await createPollsTestApp();

    const createRes = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Q?',
        options: ['A', 'B', 'C'],
      }),
    });
    const poll = (await createRes.json()) as { id: string };

    // Cast votes
    const v1 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId: poll.id, optionIndex: 0 }),
    });
    const v2 = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-2'),
      body: JSON.stringify({ pollId: poll.id, optionIndex: 1 }),
    });

    // Debug: if votes fail, the results test will fail downstream
    expect(v1.status).toBe(201);
    expect(v2.status).toBe(201);

    const resultsRes = await app.request(`/polls/polls/${poll.id}/results`, {
      headers: { 'x-user-id': 'user-1' },
    });

    expect(resultsRes.status).toBe(200);
    const results = (await resultsRes.json()) as {
      poll: { id: string };
      results: Array<{ optionIndex: number; count: number; voters?: string[] }>;
      totalVotes: number;
    };
    expect(results.poll.id).toBe(poll.id);
    expect(results.totalVotes).toBe(2);
    expect(results.results[0].count).toBe(1);
    expect(results.results[1].count).toBe(1);
    expect(results.results[2].count).toBe(0);
  });

  it('results omit voter IDs for anonymous polls', async () => {
    const { app } = await createPollsTestApp();

    const createRes = await app.request('/polls/polls', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Q?',
        options: ['A', 'B'],
        anonymous: true,
      }),
    });
    const poll = (await createRes.json()) as { id: string };

    const voteRes = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: headers('voter-1'),
      body: JSON.stringify({ pollId: poll.id, optionIndex: 0 }),
    });
    expect(voteRes.status).toBe(201);

    const resultsRes = await app.request(`/polls/polls/${poll.id}/results`, {
      headers: { 'x-user-id': 'user-1' },
    });

    const results = (await resultsRes.json()) as {
      results: Array<{ voters?: string[] }>;
    };
    for (const r of results.results) {
      expect(r.voters).toBeUndefined();
    }
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = await createPollsTestApp();

    const res = await app.request('/polls/polls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'src-1',
        scopeId: 'scope-1',
        question: 'Q?',
        options: ['A', 'B'],
      }),
    });

    expect(res.status).toBe(401);
  });
});
