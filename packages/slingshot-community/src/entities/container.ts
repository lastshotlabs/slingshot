import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a community container (space/channel).
 *
 * Exported as `ContainerEntity` from the package index to avoid name collision
 * with the `Container` model interface.
 *
 * @remarks
 * Soft-delete is enabled via the `deletedAt` field. The `getBySlug` custom
 * operation provides URL-routing by slug and optional tenant scope.
 *
 * Container creation is gated by the `containerCreationGuard` middleware,
 * which enforces the `containerCreation: 'admin' | 'user'` policy from the
 * plugin config.
 */
export const Container = defineEntity('Container', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    slug: field.string(),
    name: field.string(),
    description: field.string({ optional: true }),
    /** Parent container ID for category hierarchies. Max depth 3. */
    parentId: field.string({ optional: true }),
    /** Container type — drives UI layout and behavior. */
    type: field.enum(['forum', 'category', 'blog', 'qa', 'announcement'] as const, {
      default: 'forum',
    }),
    /** Join policy for the container. */
    joinPolicy: field.enum(['open', 'request', 'invite'] as const, { default: 'open' }),
    /** Banner image URL. */
    bannerUrl: field.string({ optional: true }),
    /** Icon image URL. */
    iconUrl: field.string({ optional: true }),
    /** Theme key for container styling. */
    theme: field.string({ optional: true }),
    createdBy: field.string(),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
    deletedAt: field.date({ optional: true }),
  },
  indexes: [
    index(['slug', 'tenantId'], { unique: true }),
    index(['tenantId']),
    index(['deletedAt']),
  ],
  softDelete: { field: 'deletedAt', strategy: 'non-null' },
  routes: {
    defaults: { auth: 'userAuth' },

    get: { auth: 'none' },
    list: { auth: 'none' },

    create: {
      permission: { requires: 'community:container.write' },
      event: { key: 'community:container.created', payload: ['id', 'slug', 'createdBy'] },
      middleware: ['containerCreationGuard'],
    },
    update: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'param:id' },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.delete',
        scope: { resourceType: 'community:container', resourceId: 'param:id' },
      },
      event: { key: 'community:container.deleted', payload: ['id'] },
    },

    operations: {
      getBySlug: { auth: 'none' },
    },

    clientSafeEvents: ['community:container.created', 'community:container.deleted'],

    middleware: { containerCreationGuard: true },
  },
});

/**
 * Custom operations for the Container entity.
 *
 * - `getBySlug`: looks up a container by its URL-safe slug and optional tenantId.
 */
export const containerOperations = defineOperations(Container, {
  getBySlug: op.lookup({
    fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
    returns: 'one',
  }),
});
