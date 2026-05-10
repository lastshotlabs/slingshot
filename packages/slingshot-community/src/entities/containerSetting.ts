// packages/slingshot-community/src/entities/containerSetting.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for per-container moderation settings.
 *
 * Overrides plugin-level defaults for slow mode, word filters, and
 * rate limits. Read by middleware at request time.
 */
export const ContainerSetting = defineEntity('ContainerSetting', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    containerId: field.string(),
    tenantId: field.string({ optional: true }),
    slowModeSec: field.integer({ default: 0 }),
    wordFilter: field.json({ optional: true }),
    threadCreateRateCount: field.integer({ optional: true }),
    threadCreateRateWindowSec: field.integer({ optional: true }),
    replyCreateRateCount: field.integer({ optional: true }),
    replyCreateRateWindowSec: field.integer({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['containerId'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    get: {
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    list: {
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'query:containerId' },
      },
    },
    create: {
      // Client allowlist — `id`/`createdAt`/`updatedAt` auto. All
      // remaining fields are moderator-tunable settings.
      input: {
        allow: [
          'containerId',
          'tenantId',
          'slowModeSec',
          'wordFilter',
          'threadCreateRateCount',
          'threadCreateRateWindowSec',
          'replyCreateRateCount',
          'replyCreateRateWindowSec',
        ],
      },
      permission: {
        requires: 'community:container.manage-settings',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
    },
    update: {
      // Editable surface — narrower than create. `containerId` is fixed
      // post-create; uniqueness on `containerId` enforces one settings row.
      input: {
        allow: [
          'slowModeSec',
          'wordFilter',
          'threadCreateRateCount',
          'threadCreateRateWindowSec',
          'replyCreateRateCount',
          'replyCreateRateWindowSec',
        ],
      },
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
      getByContainer: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.manage-settings',
          scope: { resourceType: 'community:container', resourceId: 'param:containerId' },
        },
      },
    },
  },
});

/**
 * Custom operations for the ContainerSetting entity.
 *
 * - `getByContainer`: Lookup settings by containerId.
 */
export const containerSettingOperations = defineOperations(ContainerSetting, {
  getByContainer: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'one',
  }),
});
