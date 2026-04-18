import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Persisted organization record.
 */
export const Organization = defineEntity('Organization', {
  namespace: 'organizations',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    name: field.string(),
    slug: field.string({ immutable: true }),
    description: field.string({ optional: true }),
    logoUrl: field.string({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['slug'], { unique: true }), index(['tenantId']), index(['tenantId', 'name'])],
  routes: {
    defaults: { auth: 'userAuth' },
    list: { middleware: ['organizationsAdminGuard'] },
    create: { middleware: ['organizationsAdminGuard'] },
    update: { middleware: ['organizationsAdminGuard'] },
    delete: { middleware: ['organizationsAdminGuard'] },
    disable: ['get'],
    operations: {
      getBySlug: {
        auth: 'userAuth',
        method: 'get',
        path: 'by-slug/:slug',
        middleware: ['organizationsAdminGuard'],
      },
      listMine: { auth: 'userAuth', method: 'get', path: 'mine' },
    },
    middleware: { organizationsAdminGuard: true },
  },
});

/**
 * Named organization queries.
 */
export const organizationOperations = defineOperations(Organization, {
  getBySlug: op.lookup({
    fields: { slug: 'param:slug' },
    returns: 'one',
  }),
  listMine: op.custom({
    http: { method: 'get', path: 'mine' },
  }),
});
