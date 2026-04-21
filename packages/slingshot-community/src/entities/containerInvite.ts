// packages/slingshot-community/src/entities/containerInvite.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a container invite link.
 *
 * Invite links carry a unique capability token. Anyone with the token can
 * join the container (subject to ban checks and use-count limits).
 *
 * @remarks
 * Key operations:
 * - `redeemInvite`: Atomic claim + member creation.
 * - `claimInviteSlot`: Internal atomic claim (no HTTP route).
 * - `releaseInviteSlot`: Internal compensating op (no HTTP route).
 */
export const ContainerInvite = defineEntity('ContainerInvite', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string({ immutable: true }),
    token: field.string({ immutable: true }),
    createdBy: field.string({ immutable: true }),
    maxUses: field.integer({ optional: true }),
    usesRemaining: field.integer({ optional: true }),
    expiresAt: field.date({ optional: true }),
    revokedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['token'], { unique: true }), index(['containerId'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'createdBy', from: 'ctx:authUserId' },
    get: {},
    list: {},
    create: {
      permission: {
        requires: 'community:container.manage-members',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      event: { key: 'community:invite.created', payload: ['id', 'containerId'] },
    },
    delete: {
      permission: {
        requires: 'community:container.manage-members',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      event: { key: 'community:invite.revoked', payload: ['id', 'containerId'] },
    },
    operations: {
      redeemInvite: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the ContainerInvite entity.
 *
 * - `findByToken`: Capability-based lookup by token.
 * - `redeemInvite`: Atomic claim + join flow. Handler wired in plugin.
 * - `listByContainer`: All invites for a container.
 * - `claimInviteSlot`: Internal atomic claim (no HTTP route).
 * - `releaseInviteSlot`: Internal compensating release (no HTTP route).
 */
export const containerInviteOperations = defineOperations(ContainerInvite, {
  findByToken: op.lookup({
    fields: { token: 'param:token' },
    returns: 'one',
  }),

  /** Atomic claim + join. Handler wired by plugin. */
  redeemInvite: op.custom({
    http: { method: 'post', path: 'redeem' },
  }),

  /** All invites for a container. */
  listByContainer: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'many',
  }),

  /** Internal: atomic slot claim (no HTTP). */
  claimInviteSlot: op.custom({}),

  /** Internal: compensating slot release (no HTTP). */
  releaseInviteSlot: op.custom({}),
});
