import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a container membership record.
 *
 * Exported as `ContainerMemberEntity` from the package index.
 *
 * @remarks
 * The `create` route is treated as a self-join endpoint: the authenticated user
 * may only create their own membership and the effective role is always
 * normalized to `member`. Elevated roles are granted only through `assignRole`.
 *
 * The `assignRole` upsert operation allows role changes without deleting the
 * existing membership. The `grantManager` middleware reconciles the backing
 * permission grants after promotions, demotions, and removals.
 *
 * Cascade: when `auth:user.deleted` fires, all memberships for that user are
 * hard-deleted.
 */
export const ContainerMember = defineEntity('ContainerMember', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string(),
    userId: field.string(),
    role: field.enum(['member', 'moderator', 'owner'] as const, { default: 'member' }),
    joinedAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['containerId', 'userId'], { unique: true }),
    index(['containerId']),
    index(['containerId', 'role']),
    index(['userId']),
  ],
  uniques: [{ fields: ['containerId', 'userId'] }],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId' },

    list: { auth: 'none' },

    create: {
      middleware: ['memberJoinGuard', 'grantManager'],
      event: { key: 'community:member.joined', payload: ['containerId', 'userId'] },
    },
    delete: {
      permission: {
        requires: 'community:container.manage-members',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      middleware: ['grantManager'],
      event: { key: 'community:member.left', payload: ['containerId', 'userId'] },
    },

    operations: {
      listByRole: { auth: 'none' },
      assignRole: {
        permission: {
          requires: 'community:container.manage-moderators',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        middleware: ['grantManager'],
      },
    },

    clientSafeEvents: [
      'community:member.joined',
      'community:member.left',
      'community:moderator.assigned',
      'community:moderator.removed',
    ],

    middleware: { grantManager: true, memberJoinGuard: true },

    cascades: [
      {
        event: 'auth:user.deleted',
        batch: { action: 'delete', filter: { userId: 'param:userId' } },
      },
    ],
  },
});

/**
 * Custom operations for the ContainerMember entity.
 *
 * - `listByRole`: members of a container filtered by role.
 * - `getMember`: look up a single membership by containerId + userId.
 * - `isMember`: boolean existence check for a (containerId, userId) pair.
 * - `assignRole`: upsert a member's role without dropping the record.
 * - `removeUserMemberships`: batch-delete all memberships for a user (used by
 *   the user-deletion cascade).
 */
export const containerMemberOperations = defineOperations(ContainerMember, {
  listByRole: op.lookup({
    fields: { containerId: 'param:containerId', role: 'param:role' },
    returns: 'many',
  }),

  getMember: op.lookup({
    fields: { containerId: 'param:containerId', userId: 'param:userId' },
    returns: 'one',
  }),

  isMember: op.exists({
    fields: { containerId: 'param:containerId', userId: 'param:userId' },
  }),

  assignRole: op.upsert({
    match: ['containerId', 'userId'],
    set: ['role'],
    returns: 'entity',
  }),

  removeUserMemberships: op.batch({
    action: 'delete',
    filter: { userId: 'param:userId' },
    returns: 'count',
  }),
});
