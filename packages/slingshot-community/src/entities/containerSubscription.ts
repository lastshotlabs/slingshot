// packages/slingshot-community/src/entities/containerSubscription.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user's subscription to a container.
 *
 * Controls notification delivery preferences at the container level.
 * `notifyOn` determines which events generate notifications.
 */
export const ContainerSubscription = defineEntity('ContainerSubscription', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    userId: field.string({ immutable: true }),
    containerId: field.string({ immutable: true }),
    notifyOn: field.enum(['all', 'mentions', 'none'] as const, { default: 'mentions' }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['userId', 'containerId'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['listSubscribers', 'getSubscription'],
    dataScope: { field: 'userId', from: 'ctx:actor.id' },
    get: {},
    list: {},
    create: {
      permission: {
        requires: 'community:container.read',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      event: { key: 'community:subscription.created', payload: ['id', 'userId', 'containerId'] },
    },
    update: {},
    delete: {
      event: { key: 'community:subscription.deleted', payload: ['id', 'userId', 'containerId'] },
    },
    operations: {
      listSubscribers: { auth: 'userAuth' },
      getSubscription: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the ContainerSubscription entity.
 *
 * - `listSubscribers`: All subscribers for a container.
 * - `getSubscription`: Single subscription lookup by userId + containerId.
 */
export const containerSubscriptionOperations = defineOperations(ContainerSubscription, {
  listSubscribers: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'many',
  }),

  getSubscription: op.lookup({
    fields: { userId: 'param:userId', containerId: 'param:containerId' },
    returns: 'one',
  }),
});
