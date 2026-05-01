// packages/slingshot-community/src/entities/warning.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a moderator warning issued to a user.
 *
 * Warnings are container-scoped. The `acknowledgedAt` field is set when
 * the user acknowledges the warning via the `acknowledge` operation.
 */
export const Warning = defineEntity('Warning', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    userId: field.string({ immutable: true }),
    containerId: field.string({ immutable: true }),
    issuedBy: field.string({ immutable: true }),
    reason: field.string(),
    severity: field.enum(['low', 'medium', 'high'] as const, { default: 'low' }),
    acknowledgedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['userId', 'containerId']),
    index(['userId', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['listByUser'],
    dataScope: [
      { field: 'userId', from: 'ctx:actor.id', applyTo: ['get', 'list'] },
      { field: 'issuedBy', from: 'ctx:actor.id', applyTo: ['create'] },
    ],
    get: {},
    list: {},
    create: {
      permission: {
        requires: 'community:container.warn-user',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      event: {
        key: 'community:user.warned',
        payload: ['id', 'userId', 'containerId', 'severity'],
      },
    },
    operations: {
      acknowledge: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.warn-user',
          ownerField: 'userId',
          scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
        },
      },
      listByUser: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the Warning entity.
 *
 * - `acknowledge`: Set `acknowledgedAt` on the warning.
 * - `listByUser`: All warnings for a user.
 */
export const warningOperations = defineOperations(Warning, {
  acknowledge: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['acknowledgedAt'],
  }),

  listByUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),
});
