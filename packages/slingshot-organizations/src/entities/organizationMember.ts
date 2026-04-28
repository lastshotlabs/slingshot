import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Persisted organization membership.
 *
 * `id` is a scoped composite key derived from `orgId:userId` so the same user
 * can belong to multiple organizations without primary-key collisions.
 */
export const OrganizationMember = defineEntity('OrganizationMember', {
  namespace: 'organizations',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    orgId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    role: field.string({ default: 'member' }),
    joinedAt: field.date({ default: 'now', immutable: true }),
    invitedBy: field.string({ optional: true }),
  },
  indexes: [index(['orgId', 'userId'], { unique: true }), index(['orgId']), index(['userId'])],
  routes: {
    defaults: { auth: 'userAuth', middleware: ['organizationsAdminGuard'] },
    dataScope: { field: 'orgId', from: 'param:orgId' },
    middleware: { organizationsAdminGuard: true },
  },
});

/**
 * Organization-member helper queries.
 */
export const organizationMemberOperations = defineOperations(OrganizationMember, {
  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),
  findByUser: op.lookup({
    fields: { orgId: 'param:orgId', userId: 'param:userId' },
    returns: 'one',
  }),
});
