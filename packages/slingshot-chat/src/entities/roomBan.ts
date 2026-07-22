import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

/** Persistent room-level admission denial managed through ChatModerationPeer. */
export const RoomBan = defineEntity('RoomBan', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    bannedBy: field.string(),
    reason: field.string({ optional: true }),
    expiresAt: field.date({ optional: true }),
    liftedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['roomId', 'userId'], { unique: true }), index(['roomId'])],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['get', 'list', 'create', 'update', 'delete'],
  },
});
