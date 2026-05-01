// packages/slingshot-chat/src/entities/pin.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a pinned message.
 *
 * Any room admin can pin or unpin a message. Pinned messages appear in the
 * room's "Pinned Messages" panel.
 *
 * @remarks
 * Key operations:
 * - `listByRoom`: All pinned messages in a room, ordered by `pinnedAt` descending.
 * - `unpin`: Remove a pin by `(roomId, messageId)` composite key.
 * - `isPinned`: Check if a message is pinned in a room.
 */
export const Pin = defineEntity('Pin', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string({ immutable: true }),
    messageId: field.string({ immutable: true }),
    pinnedBy: field.string({ immutable: true }),
    pinnedAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['roomId', 'pinnedAt'], { direction: 'desc' }),
    index(['roomId', 'messageId'], { unique: true }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['list', 'update'],
    dataScope: { field: 'pinnedBy', from: 'ctx:actor.id', applyTo: ['create'] },
    get: {
      auth: 'userAuth',
      permission: {
        requires: 'chat:room.read',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
    },
    create: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
      },
      event: {
        key: 'chat:message.pinned',
        payload: ['id', 'roomId', 'messageId', 'pinnedBy'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:pinnedBy',
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
    },
    delete: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
      event: {
        key: 'chat:message.unpinned',
        payload: ['id', 'roomId', 'messageId'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
    },
    operations: {
      listByRoom: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.read',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
      unpin: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.manage',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
      isPinned: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.read',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
    },
  },
});

/**
 * Custom operations for the Pin entity.
 *
 * - `listByRoom`: All pins in a room.
 * - `unpin`: Delete the pin for a `(roomId, messageId)` pair.
 * - `isPinned`: Check if a message is currently pinned.
 */
export const pinOperations = defineOperations(Pin, {
  listByRoom: op.lookup({
    fields: { roomId: 'param:roomId' },
    returns: 'many',
  }),

  unpin: op.batch({
    action: 'delete',
    filter: { roomId: 'param:roomId', messageId: 'param:messageId' },
  }),

  isPinned: op.exists({
    fields: { roomId: 'param:roomId', messageId: 'param:messageId' },
  }),
});
