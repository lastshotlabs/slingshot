import { describe, expect, test } from 'bun:test';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-notifications';
import { notifyMentions } from '../../src/lib/mentions';
import type { NotifyMentionsDeps } from '../../src/lib/mentions';
import type { Reply, Thread } from '../../src/types/models';

type ThreadAdapter = EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;
type ReplyAdapter = EntityAdapter<Reply, Record<string, unknown>, Record<string, unknown>>;

function stubDeps(opts: { thread?: Partial<Thread> | null; reply?: Partial<Reply> | null }) {
  const notifications: Record<string, unknown>[] = [];
  const builder = {
    async notify(payload: Record<string, unknown>) {
      notifications.push(payload);
    },
  } as unknown as NotificationBuilder;
  const threadAdapter = {
    async getById() {
      return (opts.thread as Thread) ?? null;
    },
  } as unknown as ThreadAdapter;
  const replyAdapter = {
    async getById() {
      return (opts.reply as Reply) ?? null;
    },
  } as unknown as ReplyAdapter;

  const deps: NotifyMentionsDeps = { builder, threadAdapter, replyAdapter };
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
