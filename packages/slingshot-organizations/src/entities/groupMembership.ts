import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

/**
 * Persisted group membership.
 *
 * `id` is a scoped composite key derived from `groupId:userId` so the same user
 * can belong to multiple groups without primary-key collisions.
 */
export const GroupMembership = defineEntity('GroupMembership', {
  namespace: 'organizations',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    groupId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    role: field.enum(['owner', 'admin', 'member'] as const, { default: 'member' }),
    joinedAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['groupId', 'userId'], { unique: true }), index(['groupId']), index(['userId'])],
  routes: {
    defaults: { auth: 'userAuth', middleware: ['groupsAdminGuard'] },
    dataScope: { field: 'groupId', from: 'param:groupId' },
    disable: ['update'],
    middleware: { groupsAdminGuard: true },
  },
});
