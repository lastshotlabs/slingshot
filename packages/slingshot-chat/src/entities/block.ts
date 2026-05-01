// packages/slingshot-chat/src/entities/block.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user block relationship.
 *
 * When user A blocks user B:
 * - A cannot receive DMs from B.
 * - B cannot create a new DM room targeting A.
 * - In shared rooms, B's messages may be filtered client-side.
 *
 * @remarks
 * Key operations:
 * - `isBlocked`: Check if `blockerId` has blocked `blockedId`.
 * - `listByBlocker`: All users blocked by a given user.
 * - `unblockUser`: Remove a block by `(blockerId, blockedId)` composite key.
 */
export const Block = defineEntity('Block', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    blockerId: field.string({ immutable: true }),
    blockedId: field.string({ immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['blockerId', 'blockedId'], { unique: true }), index(['blockerId'])],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['update', 'isBlocked', 'listByBlocker', 'unblockUser'],
    dataScope: { field: 'blockerId', from: 'ctx:actor.id' },
    get: { auth: 'userAuth' },
    list: { auth: 'userAuth' },
    create: {
      event: { key: 'chat:user.blocked', payload: ['blockerId', 'blockedId'] },
    },
    delete: {
      event: { key: 'chat:user.unblocked', payload: ['blockerId', 'blockedId'] },
    },
    operations: {
      isBlocked: { auth: 'userAuth' },
      listByBlocker: { auth: 'userAuth' },
      unblockUser: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the Block entity.
 *
 * - `isBlocked`: Check if a block exists between two users.
 * - `listByBlocker`: All blocks initiated by a given user.
 * - `unblockUser`: Delete the block for a `(blockerId, blockedId)` pair.
 */
export const blockOperations = defineOperations(Block, {
  isBlocked: op.exists({
    fields: { blockerId: 'param:blockerId', blockedId: 'param:blockedId' },
  }),

  listByBlocker: op.lookup({
    fields: { blockerId: 'param:blockerId' },
    returns: 'many',
  }),

  unblockUser: op.batch({
    action: 'delete',
    filter: { blockerId: 'param:blockerId', blockedId: 'param:blockedId' },
  }),
});
