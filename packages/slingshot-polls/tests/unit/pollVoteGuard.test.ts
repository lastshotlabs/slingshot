/**
 * pollVoteGuard unit tests.
 *
 * Covers every rejection branch from the enterprise invariants:
 * 1. Poll not found → 404
 * 2. poll.closed === true → 403 POLL_CLOSED
 * 3. poll.closesAt in past → 403 POLL_CLOSED
 * 4. Single-select, user already voted → 409 ALREADY_VOTED
 * 5. optionIndex out of range → 400 INVALID_OPTION
 * 6. Multi-select multiple options → Allowed (one row per option)
 * 7. Happy path → next() called
 */
import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { buildPollVoteGuard } from '../../src/middleware/pollVoteGuard';
import type { PollAdapter, PollVoteAdapter } from '../../src/types/adapters';
import { POLL_VOTE_ERRORS } from '../../src/types/public';
import type { PollRecord, PollVoteRecord } from '../../src/types/public';

function makePoll(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: 'poll-1',
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    authorId: 'user-author',
    question: 'Pick one',
    options: ['A', 'B', 'C'],
    multiSelect: false,
    anonymous: false,
    closed: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVote(overrides: Partial<PollVoteRecord> = {}): PollVoteRecord {
  return {
    id: 'vote-1',
    pollId: 'poll-1',
    userId: 'user-1',
    optionIndex: 0,
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestApp(
  pollAdapter: Partial<PollAdapter>,
  pollVoteAdapter: Partial<PollVoteAdapter>,
) {
  const guard = buildPollVoteGuard({
    pollAdapter: pollAdapter as PollAdapter,
    pollVoteAdapter: pollVoteAdapter as PollVoteAdapter,
  });

  const app = new Hono<AppEnv>();
  // Simulate auth middleware setting actor.
  app.use('*', async (c, next) => {
    c.set(
      'actor',
      Object.freeze({
        id: 'user-1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      }),
    );
    await next();
  });
  app.post('/vote', guard, c => c.json({ ok: true }));
  return app;
}

describe('pollVoteGuard', () => {
  // Enterprise invariant: "Poll deleted before a late vote attempt completes"
  it('rejects with 404 when poll not found', async () => {
    const app = createTestApp(
      { getById: async () => null },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(404);
  });

  // Enterprise invariant: "Poll closes between pre-check and vote write"
  it('rejects with 403 POLL_CLOSED when poll.closed === true', async () => {
    const app = createTestApp(
      { getById: async () => makePoll({ closed: true }) },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain(POLL_VOTE_ERRORS.POLL_CLOSED);
  });

  // Enterprise invariant: "Poll closes between pre-check and vote write"
  it('rejects with 403 POLL_CLOSED when closesAt is in the past', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const app = createTestApp(
      { getById: async () => makePoll({ closesAt: pastDate }) },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain(POLL_VOTE_ERRORS.POLL_CLOSED);
  });

  // Enterprise invariant: "Same user votes twice on a single-select poll"
  it('rejects with 409 ALREADY_VOTED on single-select duplicate', async () => {
    const app = createTestApp(
      { getById: async () => makePoll({ multiSelect: false }) },
      {
        listByPoll: async () => ({
          items: [makeVote({ userId: 'user-1', optionIndex: 0 })],
        }),
      },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 1 }),
    });

    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain(POLL_VOTE_ERRORS.ALREADY_VOTED);
  });

  it('rejects with 400 INVALID_OPTION when optionIndex out of range', async () => {
    const app = createTestApp(
      { getById: async () => makePoll() }, // 3 options: [A, B, C]
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 5 }),
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(POLL_VOTE_ERRORS.INVALID_OPTION);
  });

  it('rejects negative optionIndex', async () => {
    const app = createTestApp(
      { getById: async () => makePoll() },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: -1 }),
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(POLL_VOTE_ERRORS.INVALID_OPTION);
  });

  // Enterprise invariant: "Same user votes multiple options on multi-select"
  it('allows multi-select vote even if user already voted another option', async () => {
    const app = createTestApp(
      { getById: async () => makePoll({ multiSelect: true }) },
      {
        listByPoll: async () => ({
          items: [makeVote({ userId: 'user-1', optionIndex: 0 })],
        }),
      },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('calls next() on happy path (valid vote)', async () => {
    const app = createTestApp(
      { getById: async () => makePoll() },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('allows closesAt in the future', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const app = createTestApp(
      { getById: async () => makePoll({ closesAt: futureDate }) },
      { listByPoll: async () => ({ items: [] }) },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(200);
  });

  it('does not check duplicate votes for multi-select polls', async () => {
    // The guard should skip the listByPoll call entirely for multi-select.
    const listByPoll = mock(async () => ({ items: [] }));
    const app = createTestApp(
      { getById: async () => makePoll({ multiSelect: true }) },
      { listByPoll },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    expect(res.status).toBe(200);
    expect(listByPoll).not.toHaveBeenCalled();
  });

  it('only rejects single-select when the SAME user has voted (not other users)', async () => {
    const app = createTestApp(
      { getById: async () => makePoll({ multiSelect: false }) },
      {
        listByPoll: async () => ({
          // Other user voted, not 'user-1'
          items: [makeVote({ userId: 'other-user', optionIndex: 0 })],
        }),
      },
    );

    const res = await app.request('/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: 'poll-1', optionIndex: 0 }),
    });

    // Should pass — user-1 hasn't voted yet.
    expect(res.status).toBe(200);
  });
});
