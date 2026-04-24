// packages/slingshot-community/src/entities/threadSubscription.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user's subscription to a specific thread.
 *
 * Controls notification delivery for new replies to the thread.
 */
export const ThreadSubscription = defineEntity('ThreadSubscription', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    userId: field.string({ immutable: true }),
    threadId: field.string({ immutable: true }),
    notifyOn: field.enum(['all', 'none'] as const, { default: 'all' }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['userId', 'threadId'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    get: {},
    list: {},
    create: {},
    update: {},
    delete: {},
    operations: {
      getSubscription: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the ThreadSubscription entity.
 *
 * - `getSubscription`: Single subscription lookup by userId + threadId.
 * - `listByThread`: All subscribers to a thread.
 */
export const threadSubscriptionOperations = defineOperations(ThreadSubscription, {
  getSubscription: op.lookup({
    fields: { userId: 'param:userId', threadId: 'param:threadId' },
    returns: 'one',
  }),

  listByThread: op.lookup({
    fields: { threadId: 'param:threadId' },
    returns: 'many',
  }),
});
