// packages/slingshot-community/src/entities/tag.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a community tag.
 *
 * Tags are tenant-scoped labels that can be applied to threads via `ThreadTag`.
 * `usageCount` is denormalized and updated by `tagUsageIncrement` /
 * `tagUsageDecrement` middleware on ThreadTag create/delete.
 */
export const Tag = defineEntity('Tag', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    slug: field.string(),
    label: field.string(),
    description: field.string({ optional: true }),
    color: field.string({ optional: true }),
    usageCount: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['slug', 'tenantId'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    get: { auth: 'none' },
    list: { auth: 'none' },
    create: {
      permission: { requires: 'community:tag.write' },
      event: {
        key: 'community:tag.created',
        payload: ['id', 'slug'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'community:tag',
          resourceId: 'record:id',
        },
      },
    },
    update: {
      permission: { requires: 'community:tag.write' },
    },
    delete: {
      permission: { requires: 'community:tag.write' },
    },
  },
});

/**
 * Custom operations for the Tag entity.
 *
 * - `getBySlug`: lookup by slug and optional tenantId.
 * - `incrementUsage`: atomically increment usageCount.
 * - `decrementUsage`: atomically decrement usageCount.
 */
export const tagOperations = defineOperations(Tag, {
  getBySlug: op.lookup({
    fields: { slug: 'param:slug', tenantId: 'param:tenantId' },
    returns: 'one',
  }),

  incrementUsage: op.increment({
    field: 'usageCount',
    by: 1,
    match: { id: 'param:id' },
  }),

  decrementUsage: op.increment({
    field: 'usageCount',
    by: -1,
    match: { id: 'param:id' },
  }),
});
