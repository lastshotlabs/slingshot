import { describe, expect, it } from 'bun:test';
import { createPollsTestApp } from '../../src/testing';

describe('manifest bootstrap — JSON-only poll lifecycle', () => {
  it('boots from config and runs full lifecycle', async () => {
    const { app } = await createPollsTestApp();

    // 1. Create a poll
    const createRes = await app.request('/polls/polls', {
      method: 'POST',
      headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'msg-1',
        scopeId: 'room-1',
        question: 'Best framework?',
        options: ['Hono', 'Express', 'Fastify'],
        multiSelect: false,
        anonymous: false,
      }),
    });
    expect(createRes.status).toBe(201);
    const poll = (await createRes.json()) as { id: string };

    // 2. Vote
    const voteRes = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: { 'x-user-id': 'voter-1', 'content-type': 'application/json' },
      body: JSON.stringify({ pollId: poll.id, optionIndex: 0 }),
    });
    expect(voteRes.status).toBe(201);

    // 3. Results
    const resultsRes = await app.request(`/polls/polls/${poll.id}/results`, {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(resultsRes.status).toBe(200);
    const results = (await resultsRes.json()) as { totalVotes: number };
    expect(results.totalVotes).toBe(1);

    // 4. Close (named op — POST with JSON body)
    const closeRes = await app.request('/polls/polls/close-poll', {
      method: 'POST',
      headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({ id: poll.id }),
    });
    expect(closeRes.status).toBe(200);
    const closed = (await closeRes.json()) as { closed: boolean };
    expect(closed.closed).toBe(true);

    // 5. Vote on closed poll fails
    const lateVoteRes = await app.request('/polls/poll-votes', {
      method: 'POST',
      headers: { 'x-user-id': 'voter-2', 'content-type': 'application/json' },
      body: JSON.stringify({ pollId: poll.id, optionIndex: 1 }),
    });
    expect(lateVoteRes.status).toBe(403);

    // 6. Delete
    const deleteRes = await app.request(`/polls/polls/${poll.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(deleteRes.status).toBe(204);
  });

  it('handles custom mountPath via config', async () => {
    const { app } = await createPollsTestApp({ mountPath: '/api/polls' });

    const res = await app.request('/api/polls/polls', {
      method: 'POST',
      headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'msg-1',
        scopeId: 'room-1',
        question: 'Q?',
        options: ['A', 'B'],
      }),
    });
    expect(res.status).toBe(201);
  });

  it('respects maxOptions config', async () => {
    const { app } = await createPollsTestApp({ maxOptions: 3 });

    const res = await app.request('/polls/polls', {
      method: 'POST',
      headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'test:source',
        sourceId: 'msg-1',
        scopeId: 'room-1',
        question: 'Q?',
        options: ['A', 'B', 'C', 'D'],
      }),
    });
    // Should be rejected — 4 options > maxOptions(3)
    expect(res.status).toBe(400);
  });

  it('registers plugin state after bootstrap', async () => {
    const { state } = await createPollsTestApp();

    expect(state).toBeDefined();
    expect(state.config).toBeDefined();
    expect(state.config.mountPath).toBe('/polls');
    expect(state.pollAdapter).toBeDefined();
    expect(state.pollVoteAdapter).toBeDefined();
  });
});
