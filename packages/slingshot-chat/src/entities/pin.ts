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
    get: { auth: 'userAuth' },
    list: { auth: 'userAuth' },
    create: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
      },
      event: { key: 'chat:message.pinned', payload: ['id', 'roomId', 'messageId', 'pinnedBy'] },
    },
    update: { auth: 'none' },
    delete: {
      permission: {
        requires: 'chat:room.manage',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
      event: { key: 'chat:message.unpinned', payload: ['id', 'roomId', 'messageId'] },
    },
    operations: {
      listByRoom: { auth: 'userAuth' },
      unpin: { auth: 'userAuth' },
      isPinned: { auth: 'userAuth' },
    },
    clientSafeEvents: ['chat:message.pinned', 'chat:message.unpinned'],
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
