import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

/**
 * Persisted group record.
 */
export const Group = defineEntity('Group', {
  namespace: 'organizations',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    orgId: field.string({ optional: true }),
    name: field.string(),
    slug: field.string(),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['tenantId', 'slug'], { unique: true }), index(['orgId']), index(['tenantId'])],
  routes: {
    defaults: { auth: 'userAuth', middleware: ['groupsAdminGuard'] },
    middleware: { groupsAdminGuard: true },
  },
});
