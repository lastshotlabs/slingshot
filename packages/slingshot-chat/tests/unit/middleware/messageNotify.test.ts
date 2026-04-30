import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';
import { createMessageNotifyMiddleware } from '../../../src/middleware/messageNotify';
import type {
  Message,
  MessageAdapter,
  Room,
  RoomAdapter,
  RoomMember,
  RoomMemberAdapter,
} from '../../../src/types';

interface NotifyCall {
  userId: string;
  type: string;
  actorId: string;
  targetId: string;
  scopeId: string;
  dedupKey: string;
}

interface NotifyManyCall {
  userIds: string[];
  type: string;
  actorId: string;
  targetId: string;
  scopeId: string;
  dedupKey: string;
}

function stubBuilder() {
  const notifyCalls: NotifyCall[] = [];
  const notifyManyCalls: NotifyManyCall[] = [];
  const builder: NotificationBuilder = {
    async notify(opts: Record<string, unknown>) {
      notifyCalls.push(opts as unknown as NotifyCall);
    },
    async notifyMany(opts: Record<string, unknown>) {
      notifyManyCalls.push(opts as unknown as NotifyManyCall);
    },
  } as unknown as NotificationBuilder;
  return { builder, notifyCalls, notifyManyCalls };
}

function stubRoomAdapter(rooms: Map<string, Partial<Room>>): RoomAdapter {
  return {
    async getById(id: string) {
      return (rooms.get(id) as Room) ?? null;
    },
  } as unknown as RoomAdapter;
}

function stubMemberAdapter(members: Partial<RoomMember>[]): RoomMemberAdapter {
  return {
    async listByRoom() {
      return { items: members as RoomMember[], total: members.length };
    },
  } as unknown as RoomMemberAdapter;
}

function stubMessageAdapter(messages: Map<string, Partial<Message>>): MessageAdapter {
  return {
    async getById(id: string) {
      return (messages.get(id) as Message) ?? null;
    },
  } as unknown as MessageAdapter;
}

function buildApp(opts: {
  builder: NotificationBuilder;
  room: Partial<Room>;
  members: Partial<RoomMember>[];
  messages?: Map<string, Partial<Message>>;
  responseBody: Record<string, unknown>;
  responseStatus?: number;
}) {
  const rooms = new Map<string, Partial<Room>>([[opts.room.id!, opts.room]]);
  const app = new Hono();
  app.use(
    '*',
    createMessageNotifyMiddleware({
      builder: opts.builder,
      roomAdapter: stubRoomAdapter(rooms),
      memberAdapter: stubMemberAdapter(opts.members),
      messageAdapter: stubMessageAdapter(opts.messages ?? new Map()),
    }),
  );
  app.post('/messages', c => c.json(opts.responseBody, (opts.responseStatus ?? 200) as 200));
  return app;
}

async function post(app: ReturnType<typeof buildApp>) {
  return app.request('/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('messageNotify middleware', () => {
  test('sends DM notification to other member', async () => {
    const { builder, notifyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'dm' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'other-1', roomId: 'room-1', notifyOn: 'all' },
      ],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: 'Hey there!',
      },
    });

    await post(app);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.userId).toBe('other-1');
    expect(notifyCalls[0]!.type).toBe('chat:dm');
  });

  test('skips DM notification when other member has notifyOn=none', async () => {
    const { builder, notifyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'dm' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'other-1', roomId: 'room-1', notifyOn: 'none' },
      ],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: 'Hey',
      },
    });

    await post(app);
    expect(notifyCalls.length).toBe(0);
  });

  test('sends mention notifications in group rooms', async () => {
    const { builder, notifyManyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'group' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'mentioned-1', roomId: 'room-1', notifyOn: 'all' },
      ],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: 'Hey @mentioned-1',
        mentions: ['mentioned-1'],
      },
    });

    await post(app);
    expect(notifyManyCalls.length).toBe(1);
    expect(notifyManyCalls[0]!.userIds).toContain('mentioned-1');
    expect(notifyManyCalls[0]!.type).toBe('chat:mention');
  });

  test('does not notify the message author even if mentioned', async () => {
    const { builder, notifyManyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'group' },
      members: [{ userId: 'author-1', roomId: 'room-1', notifyOn: 'all' }],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: '@author-1 testing',
        mentions: ['author-1'],
      },
    });

    await post(app);
    expect(notifyManyCalls.length).toBe(0);
  });

  test('sends reply notification to parent message author', async () => {
    const { builder, notifyCalls } = stubBuilder();
    const parentMessages = new Map<string, Partial<Message>>([
      ['parent-1', { id: 'parent-1', authorId: 'parent-author', roomId: 'room-1' }],
    ]);
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'group' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'parent-author', roomId: 'room-1', notifyOn: 'all' },
      ],
      messages: parentMessages,
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: 'Replying!',
        replyToId: 'parent-1',
      },
    });

    await post(app);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.userId).toBe('parent-author');
    expect(notifyCalls[0]!.type).toBe('chat:reply');
  });

  test('does not notify when response status is non-2xx', async () => {
    const { builder, notifyCalls, notifyManyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'dm' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'other-1', roomId: 'room-1', notifyOn: 'all' },
      ],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: 'Hey',
      },
      responseStatus: 400,
    });

    await post(app);
    expect(notifyCalls.length).toBe(0);
    expect(notifyManyCalls.length).toBe(0);
  });

  test('skips when response lacks required fields', async () => {
    const { builder, notifyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'dm' },
      members: [],
      responseBody: { body: 'incomplete message' },
    });

    await post(app);
    expect(notifyCalls.length).toBe(0);
  });

  test('broadcast mentions notify all non-author members', async () => {
    const { builder, notifyManyCalls } = stubBuilder();
    const app = buildApp({
      builder,
      room: { id: 'room-1', type: 'group' },
      members: [
        { userId: 'author-1', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'user-2', roomId: 'room-1', notifyOn: 'all' },
        { userId: 'user-3', roomId: 'room-1', notifyOn: 'all' },
      ],
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'author-1',
        body: '@everyone heads up',
        broadcastMentions: ['everyone'],
      },
    });

    await post(app);
    expect(notifyManyCalls.length).toBe(1);
    expect(notifyManyCalls[0]!.userIds).toContain('user-2');
    expect(notifyManyCalls[0]!.userIds).toContain('user-3');
    expect(notifyManyCalls[0]!.userIds).not.toContain('author-1');
  });
});
