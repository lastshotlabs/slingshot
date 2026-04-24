// packages/slingshot-community/src/entities/userMute.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user mute.
 *
 * When a user mutes another user (optionally scoped to a container), content
 * from the muted user is hidden in lists and notifications are suppressed.
 */
export const UserMute = defineEntity('UserMute', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    mutedUserId: field.string({ immutable: true }),
    containerId: field.string({ optional: true, immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['userId', 'mutedUserId', 'containerId'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    get: {},
    list: {},
    create: {},
    delete: {},
    operations: {
      isMuted: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the UserMute entity.
 *
 * - `isMuted`: Check if a user is muted by the caller.
 * - `listByUser`: All mutes for a user.
 */
export const userMuteOperations = defineOperations(UserMute, {
  isMuted: op.lookup({
    fields: { userId: 'param:userId', mutedUserId: 'param:mutedUserId' },
    returns: 'one',
  }),

  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),
});
