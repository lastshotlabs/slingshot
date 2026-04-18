// packages/slingshot-community/src/entities/autoModRule.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for an auto-moderation rule.
 *
 * Rules are evaluated by `AutoModEvaluator` in the `autoMod` middleware
 * pipeline. Each rule has a `matcher` (keyword, regex, or heuristic) and
 * a `decision` (flag, reject, or shadow-ban).
 */
export const AutoModRule = defineEntity('AutoModRule', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string({ optional: true }),
    name: field.string(),
    enabled: field.boolean({ default: true }),
    /** Matcher config — { type: 'keyword'|'regex'|'heuristic', ... } */
    matcher: field.json(),
    decision: field.enum(['flag', 'reject', 'shadow-ban'] as const, { default: 'flag' }),
    priority: field.integer({ default: 0 }),
    createdBy: field.string({ immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['containerId', 'enabled']), index(['tenantId'])],
  routes: {
    defaults: { auth: 'userAuth' },
    get: {
      permission: {
        requires: 'community:container.manage-automod',
        scope: { resourceType: 'community:container', resourceId: 'query:containerId' },
      },
    },
    list: {
      permission: {
        requires: 'community:container.manage-automod',
        scope: { resourceType: 'community:container', resourceId: 'query:containerId' },
      },
    },
    create: {
      permission: {
        requires: 'community:container.manage-automod',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
    },
    update: {
      permission: {
        requires: 'community:container.manage-automod',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.manage-automod',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    operations: {
      listActive: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the AutoModRule entity.
 *
 * - `listActive`: All enabled rules for a container (includes global rules).
 */
export const autoModRuleOperations = defineOperations(AutoModRule, {
  listActive: op.lookup({
    fields: { containerId: 'param:containerId', enabled: true },
    returns: 'many',
  }),
});
