/**
 * Integration tests for reaction → target score denormalization.
 *
 * REGRESSION. `createUpdateScoreHandler` had a unit test and no caller. Its
 * own docstring said it was invoked "from the community plugin's bus event
 * handler after a reaction is created or deleted, and from
 * `reactionBuildAdapter`" — the former was never written and the latter does
 * not exist anywhere in the package. So `thread.score` and
 * `thread.reactionSummary` stayed 0 and `{}` no matter how many reactions a
 * thread collected.
 *
 * These tests go through the HTTP surface precisely because the unit test on
 * the handler passed the whole time it was dead. What needed proving is that
 * reacting to a thread moves the number on the thread.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHarness, del, get, post } from './_helpers';
import type { CommunityHarness } from './_helpers';

/** The bus subscriber runs after the mutation responds; give it a tick. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function readThread(harness: CommunityHarness, id: string): Promise<Record<string, unknown>> {
  const res = await get(harness.app, `/community/threads/${id}`);
  return (await res.json()) as Record<string, unknown>;
}

describe('reaction → thread score', () => {
  let harness: CommunityHarness;
  let threadId: string;

  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
    const res = await post(harness.app, '/community/threads', {
      containerId: 'c-score',
      title: 'Thread for scoring',
      status: 'published',
    });
    threadId = ((await res.json()) as { id: string }).id;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('a thread with no reactions scores 0', async () => {
    const thread = await readThread(harness, threadId);
    expect(thread.score ?? 0).toBe(0);
  });

  test('adding a reaction records it in the summary', async () => {
    const res = await post(harness.app, '/community/reactions', {
      targetId: threadId,
      targetType: 'thread',
      containerId: 'c-score',
      type: 'emoji',
      value: '👍',
    });
    expect(res.status).toBeLessThan(300);
    await settle();

    // NOTE the score is deliberately NOT asserted here: `emojiWeights`
    // defaults to `{}`, so an emoji reaction contributes 0 to the net score
    // until a consumer weights it. The summary is what the framework
    // guarantees unconditionally — see the weighted test below.
    const thread = await readThread(harness, threadId);

    const summary = thread.reactionSummary;
    const parsed = (typeof summary === 'string' ? JSON.parse(summary) : summary) as {
      emojis?: Record<string, number>;
    };
    expect(parsed.emojis?.['👍']).toBe(1);
  });

  test('removing the reaction returns the score to 0', async () => {
    const created = await post(harness.app, '/community/reactions', {
      targetId: threadId,
      targetType: 'thread',
      containerId: 'c-score',
      type: 'emoji',
      value: '👍',
    });
    const reactionId = ((await created.json()) as { id: string }).id;
    await settle();

    await del(harness.app, `/community/reactions/${reactionId}`);
    await settle();

    const thread = await readThread(harness, threadId);
    expect(Number(thread.score ?? 0)).toBe(0);
    const summary = thread.reactionSummary;
    const parsed = (typeof summary === 'string' ? JSON.parse(summary) : summary) as {
      emojis?: Record<string, number>;
    };
    expect(parsed.emojis?.['👍'] ?? 0).toBe(0);
  });
});

describe('reaction → thread score, with the emoji weighted', () => {
  let harness: CommunityHarness;
  let threadId: string;

  beforeEach(async () => {
    // What a consumer using the emoji vocabulary has to configure: without a
    // weight, 👍 is counted in the summary but contributes nothing to `score`,
    // so any sort by score stays flat.
    harness = await createHarness({
      grantAll: true,
      scoring: {
        algorithm: 'net',
        upvoteWeight: 1,
        downvoteWeight: 1,
        hotDecayHours: 12,
        emojiWeights: { '👍': 1 },
      },
    });
    const res = await post(harness.app, '/community/threads', {
      containerId: 'c-score',
      title: 'Thread for weighted scoring',
      status: 'published',
    });
    threadId = ((await res.json()) as { id: string }).id;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('a weighted emoji moves the score, and removing it moves it back', async () => {
    const created = await post(harness.app, '/community/reactions', {
      targetId: threadId,
      targetType: 'thread',
      containerId: 'c-score',
      type: 'emoji',
      value: '👍',
    });
    const reactionId = ((await created.json()) as { id: string }).id;
    await settle();
    expect(Number((await readThread(harness, threadId)).score ?? 0)).toBe(1);

    await del(harness.app, `/community/reactions/${reactionId}`);
    await settle();
    expect(Number((await readThread(harness, threadId)).score ?? 0)).toBe(0);
  });
});

/**
 * Stacking — one user holding SEVERAL reactions on one target.
 *
 * The unique index used to be `['targetId','targetType','userId']`, which made
 * this physically impossible: a reader could not hold 👍 and 🔥 on the same
 * thread because the second insert violated the constraint. `value` is now part
 * of the key.
 *
 * This is the case nobody exercises by hand — a UI built against the old index
 * passes every manual test as long as the tester only ever picks one emoji, and
 * fails the first time a real reader stacks two.
 */
describe('reaction stacking — several reactions per user per target', () => {
  let harness: CommunityHarness;
  let threadId: string;

  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
    const res = await post(harness.app, '/community/threads', {
      containerId: 'c-score',
      title: 'Thread for stacking',
      status: 'published',
    });
    threadId = ((await res.json()) as { id: string }).id;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function react(value: string) {
    return post(harness.app, '/community/reactions', {
      targetId: threadId,
      targetType: 'thread',
      containerId: 'c-score',
      type: 'emoji',
      value,
    });
  }

  test('one user can hold two different emoji on one thread', async () => {
    expect((await react('👍')).status).toBeLessThan(300);
    expect((await react('🔥')).status).toBeLessThan(300);
    await settle();

    const thread = await readThread(harness, threadId);
    const summary = thread.reactionSummary;
    const parsed = (typeof summary === 'string' ? JSON.parse(summary) : summary) as {
      emojis?: Record<string, number>;
    };
    expect(parsed.emojis?.['👍']).toBe(1);
    expect(parsed.emojis?.['🔥']).toBe(1);
  });

  test('the SAME emoji twice is still rejected — stacking is not duplication', async () => {
    expect((await react('💯')).status).toBeLessThan(300);
    const dupe = await react('💯');
    expect(dupe.status).toBeGreaterThanOrEqual(400);

    await settle();
    const thread = await readThread(harness, threadId);
    const summary = thread.reactionSummary;
    const parsed = (typeof summary === 'string' ? JSON.parse(summary) : summary) as {
      emojis?: Record<string, number>;
    };
    // Not 2 — the constraint held and no duplicate row exists.
    expect(parsed.emojis?.['💯']).toBe(1);
  });

  test('listByTarget filters by value and honours a limit', async () => {
    await react('👍');
    await react('🔥');
    await settle();

    const all = await get(harness.app, `/community/reactions/list-by-target/${threadId}/thread`);
    const allBody = (await all.json()) as { items?: unknown[] };
    expect(allBody.items).toHaveLength(2);

    const onlyFire = await get(
      harness.app,
      `/community/reactions/list-by-target/${threadId}/thread?value=${encodeURIComponent('🔥')}`,
    );
    const fireBody = (await onlyFire.json()) as { items?: { value?: string }[] };
    expect(fireBody.items).toHaveLength(1);
    expect(fireBody.items?.[0]?.value).toBe('🔥');

    const capped = await get(
      harness.app,
      `/community/reactions/list-by-target/${threadId}/thread?limit=1`,
    );
    const cappedBody = (await capped.json()) as { items?: unknown[]; hasMore?: boolean };
    expect(cappedBody.items).toHaveLength(1);
    expect(cappedBody.hasMore).toBe(true);
  });
});
