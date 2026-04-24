import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Persisted organization invite.
 */
export const OrganizationInvite = defineEntity('OrganizationInvite', {
  namespace: 'organizations',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    orgId: field.string({ immutable: true }),
    invitedBy: field.string({ immutable: true }),
    email: field.string({ optional: true }),
    userId: field.string({ optional: true }),
    tokenHash: field.string({ immutable: true, optional: true }),
    role: field.enum(['owner', 'admin', 'member'] as const, { default: 'member' }),
    expiresAt: field.date(),
    acceptedAt: field.date({ optional: true }),
    revokedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['tokenHash'], { unique: true }),
    index(['orgId']),
    index(['orgId', 'acceptedAt']),
    index(['orgId', 'revokedAt']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: [
      { field: 'orgId', from: 'param:orgId', applyTo: ['create', 'list', 'get'] },
      { field: 'invitedBy', from: 'ctx:actor.id', applyTo: ['create'] },
      { field: 'expiresAt', from: 'ctx:inviteExpiresAt', applyTo: ['create'] },
    ],
    create: { middleware: ['inviteCreateDefaults', 'organizationsAdminGuard'] },
    list: { middleware: ['organizationsAdminGuard'] },
    get: { middleware: ['organizationsAdminGuard'] },
    disable: ['update', 'delete'],
    operations: {
      findByToken: { auth: 'none', method: 'post', path: 'lookup' },
      redeem: { auth: 'userAuth', method: 'post', path: 'redeem' },
      revokeInvite: {
        auth: 'userAuth',
        method: 'delete',
        path: ':id',
        middleware: ['organizationsAdminGuard'],
      },
    },
    middleware: { inviteCreateDefaults: true, organizationsAdminGuard: true },
  },
});

/**
 * Invite lookup and lifecycle operations.
 */
export const organizationInviteOperations = defineOperations(OrganizationInvite, {
  findByToken: op.custom({
    http: { method: 'post', path: 'lookup' },
  }),
  redeem: op.custom({
    http: { method: 'post', path: 'redeem' },
  }),
  revokeInvite: op.custom({
    http: { method: 'delete', path: ':id' },
  }),
});
