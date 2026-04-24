// packages/slingshot-chat/src/entities/room-invite.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a room invite link.
 *
 * Invite links carry a unique capability token. Anyone with the token can
 * join the room (subject to block checks and use-count limits).
 *
 * @remarks
 * Key operations:
 * - `findByToken`: Capability-based lookup (no auth required).
 * - `redeemInvite`: Atomic claim + member creation.
 * - `revokeInvite`: Mark an invite as revoked.
 * - `listByRoom`: All invites for a room (admin-only).
 */
export const RoomInvite = defineEntity('RoomInvite', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string({ immutable: true }),
    createdBy: field.string({ immutable: true }),
    token: field.string({ immutable: true }),
    maxUses: field.integer({ optional: true }),
    useCount: field.integer({ default: 0 }),
    expiresAt: field.date({ optional: true }),
    revoked: field.boolean({ default: false }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['token'], { unique: true }), index(['roomId']), index(['roomId', 'revoked'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'createdBy', from: 'ctx:actor.id' },
    get: {},
    list: {},
    create: {
      permission: {
        requires: 'chat:room.invite',
        scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
      },
      event: {
        key: 'chat:invite.created',
        payload: ['id', 'roomId', 'token'],
        exposure: ['client-safe'],
        scope: {
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
    },
    operations: {
      findByToken: { auth: 'none' },
      redeemInvite: { auth: 'userAuth' },
      revokeInvite: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.manage',
          scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
        },
      },
      listByRoom: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.manage',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
    },
  },
});

/**
 * Custom operations for the RoomInvite entity.
 *
 * - `findByToken`: Capability-based lookup by token (no auth).
 * - `redeemInvite`: Atomic claim + join flow. Handler wired in plugin.
 * - `revokeInvite`: Transition `revoked` from false to true.
 * - `listByRoom`: All invites for a room.
 * - `claimInviteSlot`: Internal atomic claim (no HTTP route).
 * - `releaseInviteSlot`: Internal compensating op (no HTTP route).
 */
export const roomInviteOperations = defineOperations(RoomInvite, {
  findByToken: op.lookup({
    fields: { token: 'param:token' },
    returns: 'one',
  }),

  /** Atomic claim + join. Handler wired by plugin's `inviteBuildAdapter`. */
  redeemInvite: op.custom({
    http: { method: 'post', path: 'redeem' },
  }),

  /** Mark invite as revoked. */
  revokeInvite: op.transition({
    field: 'revoked',
    from: false,
    to: true,
    match: { id: 'param:id' },
  }),

  /** All invites for a room. */
  listByRoom: op.lookup({
    fields: { roomId: 'param:roomId' },
    returns: 'many',
  }),

  /** Internal: atomic slot claim (no HTTP). */
  claimInviteSlot: op.custom({}),

  /** Internal: compensating slot release (no HTTP). */
  releaseInviteSlot: op.custom({}),
});
