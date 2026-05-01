// packages/slingshot-community/src/entities/threadTag.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a thread–tag association.
 *
 * Each row links one thread to one tag. Middleware on create/delete maintains
 * the `Tag.usageCount` denormalized counter and syncs the `Thread.tagIds`
 * array field.
 */
export const ThreadTag = defineEntity('ThreadTag', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    threadId: field.string({ immutable: true }),
    tagId: field.string({ immutable: true }),
    containerId: field.string({ immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['threadId', 'tagId'], { unique: true }),
    index(['tagId', 'createdAt'], { direction: 'desc' }),
    index(['containerId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['list', 'listByTag'],
    create: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      middleware: ['publishedThreadGuard'],
      event: {
        key: 'community:thread.tagged',
        payload: ['threadId', 'tagId', 'containerId'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      event: {
        key: 'community:thread.untagged',
        payload: ['threadId', 'tagId', 'containerId'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },
    operations: {
      listByThread: { auth: 'none', middleware: ['publishedThreadGuard'] },
      listByTag: { auth: 'none' },
    },
    middleware: { publishedThreadGuard: true },
  },
});

/**
 * Custom operations for the ThreadTag entity.
 *
 * - `listByThread`: all tags for a thread.
 * - `listByTag`: all threads for a tag.
 */
export const threadTagOperations = defineOperations(ThreadTag, {
  listByThread: op.lookup({
    fields: { threadId: 'param:threadId' },
    returns: 'many',
  }),

  listByTag: op.lookup({
    fields: { tagId: 'param:tagId' },
    returns: 'many',
  }),
});
