// packages/slingshot-chat/src/entities/favorite-room.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user's favorited room.
 *
 * Favorites appear pinned at the top of the room list. `sortOrder` lets users
 * reorder their favorites. Lower values appear first.
 *
 * @remarks
 * Key operations:
 * - `listByUser`: All favorites for a user, ordered by `sortOrder`.
 * - `isFavorite`: Check if a room is in a user's favorites.
 * - `unfavorite`: Remove a favorite by `(userId, roomId)` composite key.
 * - `updateOrder`: Update the `sortOrder` for a specific favorite.
 */
export const FavoriteRoom = defineEntity('FavoriteRoom', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    roomId: field.string({ immutable: true }),
    sortOrder: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['userId', 'roomId'], { unique: true }), index(['userId', 'sortOrder'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId' },
    get: { auth: 'userAuth' },
    list: { auth: 'userAuth' },
    create: {
      event: { key: 'chat:room.favorited', payload: ['userId', 'roomId'] },
    },
    update: { auth: 'userAuth' },
    delete: {
      event: { key: 'chat:room.unfavorited', payload: ['userId', 'roomId'] },
    },
    operations: {
      listByUser: { auth: 'userAuth' },
      isFavorite: { auth: 'userAuth' },
      unfavorite: { auth: 'userAuth' },
      updateOrder: { auth: 'userAuth' },
    },
    clientSafeEvents: [],
  },
});

/**
 * Custom operations for the FavoriteRoom entity.
 *
 * - `listByUser`: All favorited rooms for a user.
 * - `isFavorite`: Check if a user has favorited a specific room.
 * - `unfavorite`: Remove the favorite for a `(userId, roomId)` pair.
 * - `updateOrder`: Update `sortOrder` for a `(userId, roomId)` pair.
 */
export const favoriteRoomOperations = defineOperations(FavoriteRoom, {
  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),

  isFavorite: op.exists({
    fields: { userId: 'param:userId', roomId: 'param:roomId' },
  }),

  unfavorite: op.batch({
    action: 'delete',
    filter: { userId: 'param:userId', roomId: 'param:roomId' },
  }),

  updateOrder: op.fieldUpdate({
    match: { userId: 'param:userId', roomId: 'param:roomId' },
    set: ['sortOrder'],
  }),
});
