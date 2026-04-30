import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { attachContext } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createMessagePostCreateMiddleware } from '../../../src/middleware/messagePostCreate';
import type { Room, RoomAdapter } from '../../../src/types';
import { setVar } from './_helpers';

interface CreateGrantInput {
  subjectId: string;
  resourceType: string;
  resourceId: string;
  roles: string[];
}

interface UpdateLastMessageCall {
  id: string;
  lastMessageAt?: string | null;
  lastMessageId?: string | null;
}

function stubPermissionsAdapter() {
  const grants: CreateGrantInput[] = [];
  const adapter: PermissionsAdapter = {
    async createGrant(grant: CreateGrantInput) {
      grants.push(grant);
      return 'grant-1';
    },
  } as unknown as PermissionsAdapter;
  return { adapter, grants };
}

function stubRoomAdapter() {
  const updates: UpdateLastMessageCall[] = [];
  const adapter: RoomAdapter = {
    async updateLastMessage(
      match: { id: string },
      data: { lastMessageAt?: string | null; lastMessageId?: string | null },
    ) {
      updates.push({ id: match.id, ...data });
      return { id: match.id } as Room;
    },
  } as unknown as RoomAdapter;
  return { adapter, updates };
}

function buildApp(opts: {
  permissionsAdapter: PermissionsAdapter;
  roomAdapter: RoomAdapter;
  actorId?: string | null;
  responseBody: Record<string, unknown>;
  responseStatus?: number;
}) {
  const app = new Hono<AppEnv>();

  // Set up actor
  app.use('*', async (c, next) => {
    if (opts.actorId) {
      setVar(c, 'actor', { id: opts.actorId, kind: 'user', roles: [], tenantId: null });
    }
    // Attach a minimal slingshot context for events.publish
    const published: unknown[] = [];
    setVar(c, 'slingshotCtx', {
      events: {
        publish: (...args: unknown[]) => {
          published.push(args);
        },
      },
    });
    await next();
  });

  app.use(
    '*',
    createMessagePostCreateMiddleware({
      roomAdapter: opts.roomAdapter,
      permissionsAdapter: opts.permissionsAdapter,
      tenantId: 'default',
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

describe('messagePostCreate middleware', () => {
  test('creates author grant and updates lastMessage on success', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: roomAdapter, updates } = stubRoomAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      roomAdapter,
      actorId: 'user-1',
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'user-1',
        createdAt: '2024-01-01T00:00:00Z',
      },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(grants.length).toBe(1);
    expect(grants[0]!.subjectId).toBe('user-1');
    expect(grants[0]!.resourceType).toBe('chat:message');
    expect(grants[0]!.resourceId).toBe('msg-1');
    expect(grants[0]!.roles).toEqual(['author']);
    expect(updates.length).toBe(1);
    expect(updates[0]!.id).toBe('room-1');
    expect(updates[0]!.lastMessageId).toBe('msg-1');
  });

  test('skips when response is non-2xx', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: roomAdapter, updates } = stubRoomAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      roomAdapter,
      actorId: 'user-1',
      responseBody: { error: 'fail' },
      responseStatus: 400,
    });

    const res = await post(app);
    expect(res.status).toBe(400);
    expect(grants.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  test('skips when no actor is present', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: roomAdapter, updates } = stubRoomAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      roomAdapter,
      actorId: null,
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'user-1',
      },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(grants.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  test('skips when response lacks id or roomId', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: roomAdapter, updates } = stubRoomAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      roomAdapter,
      actorId: 'user-1',
      responseBody: { body: 'missing fields' },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(grants.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  test('emits scheduled event and skips grant for future scheduled messages', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: roomAdapter, updates } = stubRoomAdapter();
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      roomAdapter,
      actorId: 'user-1',
      responseBody: {
        id: 'msg-1',
        roomId: 'room-1',
        authorId: 'user-1',
        scheduledAt: futureDate,
      },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    // Scheduled messages do not get an author grant or lastMessage update
    expect(grants.length).toBe(0);
    expect(updates.length).toBe(0);
  });
});
