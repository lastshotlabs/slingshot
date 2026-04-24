// packages/slingshot-chat/src/entities/message-reaction.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a message reaction.
 *
 * Stores individual emoji reactions per user per message. Aggregated counts
 * are computed from these rows and sent to clients as `chat.reaction` events.
 *
 * @remarks
 * Key operations:
 * - `addReaction`: Idempotent upsert keyed on `(userId, messageId, emoji)`.
 * - `removeReaction`: Delete a specific user's reaction to a message.
 * - `countByEmoji`: Count how many users have reacted with a given emoji.
 * - `listAggregated`: Aggregate all reactions on a message by emoji.
 * - `hasReacted`: Check whether a user has reacted with a specific emoji.
 */
export const MessageReaction = defineEntity('MessageReaction', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    messageId: field.string({ immutable: true }),
    roomId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    emoji: field.string({ immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['messageId', 'emoji']),
    index(['userId', 'messageId', 'emoji'], { unique: true }),
    index(['roomId']),
  ],
  uniques: [{ fields: ['userId', 'messageId', 'emoji'] }],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    get: { auth: 'userAuth' },
    list: { auth: 'userAuth' },
    create: {
      event: {
        key: 'chat:message.reaction.added',
        payload: ['messageId', 'roomId', 'userId', 'emoji'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:userId',
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
    },
    update: { auth: 'none' },
    delete: {
      event: {
        key: 'chat:message.reaction.removed',
        payload: ['messageId', 'roomId', 'userId', 'emoji'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:userId',
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
    },
    operations: {
      addReaction: { auth: 'userAuth' },
      removeReaction: { auth: 'userAuth' },
      countByEmoji: { auth: 'userAuth' },
      listAggregated: { auth: 'userAuth' },
      hasReacted: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the MessageReaction entity.
 *
 * - `addReaction`: Upsert keyed on `(userId, messageId, emoji)` — idempotent.
 * - `removeReaction`: Delete a user's emoji reaction from a message.
 * - `countByEmoji`: Count reactions for a specific emoji on a message.
 * - `listAggregated`: All emoji reaction aggregates for a message.
 * - `hasReacted`: Check if a user has reacted with a specific emoji.
 */
export const messageReactionOperations = defineOperations(MessageReaction, {
  addReaction: op.upsert({
    match: ['userId', 'messageId', 'emoji'],
    set: ['roomId'],
  }),

  removeReaction: op.batch({
    action: 'delete',
    filter: {
      userId: 'param:userId',
      messageId: 'param:messageId',
      emoji: 'param:emoji',
    },
  }),

  countByEmoji: op.aggregate({
    groupBy: 'emoji',
    compute: { count: 'count' },
  }),

  listAggregated: op.aggregate({
    groupBy: 'emoji',
    compute: { count: 'count' },
  }),

  hasReacted: op.exists({
    fields: { userId: 'param:userId', messageId: 'param:messageId', emoji: 'param:emoji' },
  }),
});
