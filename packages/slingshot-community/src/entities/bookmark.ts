// packages/slingshot-community/src/entities/bookmark.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user bookmark.
 *
 * Bookmarks let users save threads or replies for later. An optional
 * `tag` field supports user-defined categorization.
 */
export const Bookmark = defineEntity('Bookmark', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    targetId: field.string({ immutable: true }),
    targetType: field.enum(['thread', 'reply'] as const, { immutable: true }),
    tag: field.string({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['userId', 'createdAt'], { direction: 'desc' }),
    index(['userId', 'targetId', 'targetType'], { unique: true }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId' },
    get: {},
    list: {},
    create: {},
    update: {},
    delete: {},
    operations: {
      isBookmarked: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the Bookmark entity.
 *
 * - `isBookmarked`: Check if a target is bookmarked by the caller.
 * - `listByUser`: All bookmarks for a user.
 */
export const bookmarkOperations = defineOperations(Bookmark, {
  isBookmarked: op.lookup({
    fields: { userId: 'param:userId', targetId: 'param:targetId', targetType: 'param:targetType' },
    returns: 'one',
  }),

  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),
});
