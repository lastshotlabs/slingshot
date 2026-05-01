import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a community rule displayed to container members.
 *
 * Exported as `ContainerRuleEntity` from the package index.
 *
 * @remarks
 * Rules are ordered by the `order` field (ascending). Create multiple rules
 * and set `order` values to control display sequence. Updating `order` re-sorts
 * without deleting and re-creating records. There is no enforced uniqueness on
 * `order`, so stable sort by `createdAt` is used as a tie-breaker.
 *
 * Container rules have no auth gate on scoped reads. Write operations require
 * container settings management permission.
 */
export const ContainerRule = defineEntity('ContainerRule', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string(),
    title: field.string(),
    description: field.string({ optional: true }),
    order: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['containerId'])],
  defaultSort: { field: 'order', direction: 'asc' },
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['list'],

    get: { auth: 'none' },

    create: {
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
    },
    update: {
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },

    operations: {
      listByContainer: { auth: 'none' },
    },
  },
});

/**
 * Custom operations for the ContainerRule entity.
 *
 * - `listByContainer`: all rules for a container, ordered by the `order` field.
 *
 * @example
 * ```ts
 * import { containerRuleOperations } from '@lastshotlabs/slingshot-community';
 *
 * // Use the adapter directly (e.g. in tests or custom routes):
 * const rules = await ruleAdapter.listByContainer({ containerId: 'container-abc' });
 * ```
 */
export const containerRuleOperations = defineOperations(ContainerRule, {
  listByContainer: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'many',
  }),
});
