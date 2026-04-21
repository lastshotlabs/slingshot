// packages/slingshot-chat/src/entities/room.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a chat room.
 *
 * Rooms are the top-level container for messages and membership. Three types:
 * - `dm`: 1:1 direct message. Deterministic ID `dm-{sorted(userId1,userId2).join('-')}`.
 * - `group`: Multi-user private room with explicit membership.
 * - `broadcast`: One-to-many; only admins send.
 *
 * @remarks
 * Key operations:
 * - `findDm`: Look up an existing DM room by deterministic composite key.
 * - `updateLastMessage`: Update `lastMessageAt` / `lastMessageId` after message creation.
 */
export const Room = defineEntity('Room', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    name: field.string({ optional: true }),
    type: field.enum(['dm', 'group', 'broadcast'] as const),
    encrypted: field.boolean({ default: false }),
    retentionDays: field.integer({ optional: true }),
    /** Optional room description (e.g. channel purpose). */
    description: field.string({ optional: true }),
    /** Short topic line displayed in room header. */
    topic: field.string({ optional: true }),
    /** URL of the room's avatar image. */
    avatarUrl: field.string({ optional: true }),
    /** Whether the room is archived. Archived rooms reject new messages. */
    archived: field.boolean({ default: false }),
    /** Timestamp when the room was archived. */
    archivedAt: field.date({ optional: true }),
    lastMessageAt: field.date({ optional: true }),
    lastMessageId: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['type']), index(['tenantId', 'type']), index(['archived'])],
  routes: {
    defaults: { auth: 'userAuth' },
    get: {},
    list: {},
    create: {
      permission: { requires: 'chat:room.write' },
      event: {
        key: 'chat:room.created',
        payload: ['id', 'type', 'name'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:id',
        },
      },
      middleware: ['roomCreatorGrant'],
    },
    update: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'param:id' },
      },
      event: {
        key: 'chat:room.updated',
        payload: ['id'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:id',
        },
      },
    },
    delete: {
      permission: {
        requires: 'chat:room.delete',
        scope: { resourceType: 'chat:room', resourceId: 'param:id' },
      },
      event: {
        key: 'chat:room.deleted',
        payload: ['id'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:id',
        },
      },
    },
    operations: {
      findDm: { auth: 'userAuth' },
      findOrCreateDm: { auth: 'userAuth' },
      updateLastMessage: { auth: 'userAuth' },
      archiveRoom: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.manage',
          scope: { resourceType: 'chat:room', resourceId: 'param:id' },
        },
        event: {
          key: 'chat:room.archived',
          payload: ['id'],
          exposure: ['client-safe'],
          scope: {
            resourceType: 'chat:room',
            resourceId: 'record:id',
          },
        },
      },
      unarchiveRoom: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.manage',
          scope: { resourceType: 'chat:room', resourceId: 'param:id' },
        },
        event: {
          key: 'chat:room.unarchived',
          payload: ['id'],
          exposure: ['client-safe'],
          scope: {
            resourceType: 'chat:room',
            resourceId: 'record:id',
          },
        },
      },
    },
    middleware: { roomCreatorGrant: true },
    permissions: {
      resourceType: 'chat:room',
      actions: ['read', 'write', 'invite', 'kick', 'manage', 'delete'],
      roles: {
        owner: ['*'],
        admin: ['read', 'write', 'invite', 'kick', 'manage'],
        member: ['read', 'write'],
      },
    },
  },
});

/**
 * Custom operations for the Room entity.
 *
 * - `findDm`: Look up a DM room by its deterministic composite ID.
 * - `updateLastMessage`: Set `lastMessageAt` and `lastMessageId` after a message is created.
 */
export const roomOperations = defineOperations(Room, {
  findDm: op.lookup({
    fields: { id: 'param:id' },
    returns: 'one',
  }),

  /**
   * Find or create a DM room between the authenticated user and a target user.
   *
   * Computes a deterministic room ID `dm-{sorted(userId1,userId2).join('-')}`.
   * Checks blocks in both directions (403 if blocked). Creates room, members,
   * and permission grants on first call; returns existing room on subsequent calls.
   *
   * Backend handler is wired by the chat plugin's `roomBuildAdapter` — the
   * `op.custom` definition carries only HTTP metadata.
   */
  findOrCreateDm: op.custom({
    http: { method: 'post' },
  }),

  updateLastMessage: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['lastMessageAt', 'lastMessageId'],
  }),

  /** Archive a room — sets `archived: true` and `archivedAt` to now. */
  archiveRoom: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['archived', 'archivedAt'],
  }),

  /**
   * Unarchive a room — sets `archived: false` and clears `archivedAt`.
   *
   * The route handler bakes the literal values `{ archived: false, archivedAt: null }`
   * rather than accepting them from the request body.
   */
  unarchiveRoom: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['archived', 'archivedAt'],
  }),
});
