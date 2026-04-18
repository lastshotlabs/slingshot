import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user ban.
 *
 * Exported as `BanEntity` from the package index.
 *
 * @remarks
 * Bans are never hard-deleted; they are lifted by the `removeBan` batch
 * operation which sets `unbannedBy` and `unbannedAt`. The `banCheck`
 * middleware queries the ban store on every thread/reply creation request and
 * returns `403` if an active ban exists.
 *
 * The `banNotify` middleware fires after a ban is created, emitting a
 * `community:user.banned` event and creating an in-app notification for the
 * banned user.
 */
export const Ban = defineEntity('Ban', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    userId: field.string(),
    containerId: field.string({ optional: true }),
    bannedBy: field.string(),
    reason: field.string(),
    expiresAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    unbannedBy: field.string({ optional: true }),
    unbannedAt: field.date({ optional: true }),
  },
  indexes: [index(['userId', 'containerId']), index(['userId']), index(['tenantId'])],
  routes: {
    defaults: { auth: 'userAuth' },

    create: {
      permission: { requires: 'community:container.apply-ban' },
      event: {
        key: 'community:user.banned',
        payload: ['userId', 'containerId', 'bannedBy', 'reason', 'expiresAt'],
      },
      middleware: ['auditLog', 'banNotify'],
    },

    operations: {
      isUserBanned: { auth: 'userAuth' },
      getUserBan: { auth: 'userAuth' },
      removeBan: {
        permission: { requires: 'community:container.lift-ban' },
        event: { key: 'community:user.unbanned', payload: ['userId', 'containerId'] },
        middleware: ['auditLog'],
      },
    },

    clientSafeEvents: ['community:user.banned', 'community:user.unbanned'],

    middleware: { auditLog: true, banNotify: true },
  },
});

/**
 * Custom operations for the Ban entity.
 *
 * - `isUserBanned`: boolean check for an active ban on (userId, containerId).
 * - `getUserBan`: fetch the active ban record for a user.
 * - `removeBan`: batch-update all matching bans to set `unbannedBy` and
 *   `unbannedAt` (i.e. lift the ban). Requires the `community:container.lift-ban`
 *   permission.
 */
export const banOperations = defineOperations(Ban, {
  isUserBanned: op.exists({
    fields: { userId: 'param:userId', containerId: 'param:containerId' },
  }),

  getUserBan: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'one',
  }),

  removeBan: op.batch({
    action: 'update',
    filter: { userId: 'param:userId', containerId: 'param:containerId' },
    set: { unbannedBy: 'param:unbannedBy', unbannedAt: 'now' },
    returns: 'count',
  }),
});
