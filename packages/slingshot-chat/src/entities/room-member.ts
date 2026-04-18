// packages/slingshot-chat/src/entities/room-member.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a room membership record.
 *
 * Tracks a user's role, preferences, and read position within a room.
 * One record per user per room.
 *
 * @remarks
 * Key operations:
 * - `listByRoom`: All members of a given room.
 * - `listByUser`: All rooms a user has joined (returns membership rows).
 * - `findMember`: Look up a single membership by `roomId` + `userId`.
 * - `updateLastRead`: Advance the user's read position in a room.
 * - `countMembers`: Count members in a room.
 */
export const RoomMember = defineEntity('RoomMember', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    role: field.enum(['owner', 'admin', 'member'] as const, { default: 'member' }),
    lastReadAt: field.date({ optional: true }),
    mutedUntil: field.date({ optional: true }),
    nickname: field.string({ optional: true }),
    notifyOn: field.enum(['all', 'mentions', 'none'] as const, { default: 'all' }),
    joinedAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['roomId', 'userId'], { unique: true }), index(['userId']), index(['roomId'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId', applyTo: ['list'] },
    get: {
      permission: {
        requires: 'chat:room.read',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
    },
    list: {},
    create: {
      permission: {
        requires: 'chat:room.invite',
        scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
      },
      event: { key: 'chat:member.added', payload: ['id', 'roomId', 'userId', 'role'] },
      middleware: ['dmRoomGuard', 'memberGrant', 'memberInviteNotify'],
    },
    update: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
      event: { key: 'chat:member.updated', payload: ['id', 'roomId', 'userId'] },
    },
    delete: {
      permission: {
        requires: 'chat:room.kick',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
      event: { key: 'chat:member.removed', payload: ['id', 'roomId', 'userId'] },
    },
    operations: {
      listByRoom: { auth: 'userAuth' },
      listByUser: { auth: 'userAuth' },
      findMember: { auth: 'userAuth' },
      updateLastRead: { auth: 'userAuth' },
      countMembers: { auth: 'userAuth' },
      unreadCount: { auth: 'userAuth' },
    },
    middleware: { dmRoomGuard: true, memberGrant: true, memberInviteNotify: true },
    clientSafeEvents: ['chat:member.added', 'chat:member.updated', 'chat:member.removed'],
  },
});

/**
 * Custom operations for the RoomMember entity.
 *
 * - `listByRoom`: All members in a room.
 * - `listByUser`: All memberships for a user.
 * - `findMember`: Single membership lookup by composite key.
 * - `updateLastRead`: Update `lastReadAt` for a member.
 * - `countMembers`: Count members in a room.
 * - `unreadCount`: Per-room unread message counts for the authenticated user.
 */
export const roomMemberOperations = defineOperations(RoomMember, {
  listByRoom: op.lookup({
    fields: { roomId: 'param:roomId' },
    returns: 'many',
  }),

  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),

  findMember: op.lookup({
    fields: { roomId: 'param:roomId', userId: 'param:userId' },
    returns: 'one',
  }),

  updateLastRead: op.fieldUpdate({
    match: { roomId: 'param:roomId', userId: 'param:userId' },
    set: ['lastReadAt'],
  }),

  countMembers: op.aggregate({
    groupBy: 'roomId',
    compute: { count: 'count' },
  }),

  /**
   * Per-room unread message counts for the authenticated user.
   *
   * Cross-entity operation that joins messages × room_members. Backend
   * handler is wired by the chat plugin's `memberBuildAdapter` closure.
   */
  unreadCount: op.custom({
    http: { method: 'get', path: 'unread-count' },
  }),
});
