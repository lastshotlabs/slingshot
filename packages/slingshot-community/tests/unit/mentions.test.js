import { describe, expect, test } from 'bun:test';
import { notifyMentions } from '../../src/lib/mentions';

function stubDeps(opts) {
  const notifications = [];
  const builder = {
    async notify(payload) {
      notifications.push(payload);
    },
  };
  const threadAdapter = {
    async getById() {
      return opts.thread ?? null;
    },
  };
  const replyAdapter = {
    async getById() {
      return opts.reply ?? null;
    },
  };
  const deps = { builder, threadAdapter, replyAdapter };
  return { deps, notifications };
}
describe('notifyMentions', () => {
  test('sends notifications for explicit mentions on a thread', async () => {
    const { deps, notifications } = stubDeps({
      thread: {
        id: 't1',
        containerId: 'c1',
        authorId: 'author-1',
        mentions: ['user-2', 'user-3'],
        body: 'Hello world',
      },
    });
    await notifyMentions({ id: 't1', authorId: 'author-1', tenantId: 'tenant-1' }, deps, 'thread');
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.userId).toBe('user-2');
    expect(notifications[0]?.type).toBe('community:mention');
    expect(notifications[0]?.tenantId).toBe('tenant-1');
    expect(notifications[1]?.userId).toBe('user-3');
  });
  test('skips self-mentions (author not notified about own mention)', async () => {
    const { deps, notifications } = stubDeps({
      thread: {
        id: 't1',
        containerId: 'c1',
        authorId: 'author-1',
        mentions: ['author-1', 'user-2'],
        body: 'Hello',
      },
    });
    await notifyMentions({ id: 't1', authorId: 'author-1' }, deps, 'thread');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe('user-2');
  });
  test('no-ops when id is missing from payload', async () => {
    const { deps, notifications } = stubDeps({ thread: null });
    await notifyMentions({ authorId: 'author-1' }, deps, 'thread');
    expect(notifications).toHaveLength(0);
  });
  test('no-ops when authorId is missing from payload', async () => {
    const { deps, notifications } = stubDeps({ thread: null });
    await notifyMentions({ id: 't1' }, deps, 'thread');
    expect(notifications).toHaveLength(0);
  });
  test('no-ops when thread is not found', async () => {
    const { deps, notifications } = stubDeps({ thread: null });
    await notifyMentions({ id: 't1', authorId: 'author-1' }, deps, 'thread');
    expect(notifications).toHaveLength(0);
  });
  test('sends notifications for reply mentions', async () => {
    const { deps, notifications } = stubDeps({
      reply: {
        id: 'r1',
        threadId: 't1',
        containerId: 'c1',
        authorId: 'author-1',
        mentions: ['user-5'],
        body: 'Reply body',
      },
    });
    await notifyMentions({ id: 'r1', authorId: 'author-1' }, deps, 'reply');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe('user-5');
    expect(notifications[0]?.targetType).toBe('community:reply');
  });
  test('no-ops when reply is not found', async () => {
    const { deps, notifications } = stubDeps({ reply: null });
    await notifyMentions({ id: 'r1', authorId: 'author-1' }, deps, 'reply');
    expect(notifications).toHaveLength(0);
  });
  test('falls back to body parsing when mentions array is empty', async () => {
    const { deps, notifications } = stubDeps({
      thread: {
        id: 't1',
        containerId: 'c1',
        authorId: 'author-1',
        mentions: [],
        body: 'Hey <@user-10> check this out',
      },
    });
    await notifyMentions({ id: 't1', authorId: 'author-1' }, deps, 'thread');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe('user-10');
  });
  test('no-ops when no mentions and no body', async () => {
    const { deps, notifications } = stubDeps({
      thread: {
        id: 't1',
        containerId: 'c1',
        authorId: 'author-1',
        mentions: undefined,
        body: undefined,
      },
    });
    await notifyMentions({ id: 't1', authorId: 'author-1' }, deps, 'thread');
    expect(notifications).toHaveLength(0);
  });
});
