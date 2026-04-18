import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/** Entity definition for persisted device subscriptions across all platforms. */
export const PushSubscription = defineEntity('PushSubscription', {
  namespace: 'push',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string(),
    tenantId: field.string({ default: '' }),
    deviceId: field.string(),
    platform: field.enum(['web', 'ios', 'android'] as const),
    platformData: field.json(),
    locale: field.string({ optional: true }),
    appVersion: field.string({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    lastSeenAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['userId', 'tenantId', 'deviceId'], { unique: true }),
    index(['tenantId', 'userId']),
    index(['deviceId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['get'],
    dataScope: [
      { field: 'userId', from: 'ctx:authUserId' },
      { field: 'tenantId', from: 'ctx:tenantId' },
    ],
  },
});

/** Generated operations for subscription upsert, lookup, and touch flows. */
export const pushSubscriptionOperations = defineOperations(PushSubscription, {
  upsertByDevice: op.upsert({
    match: ['userId', 'tenantId', 'deviceId'],
    set: ['platform', 'platformData', 'locale', 'appVersion', 'lastSeenAt'],
    onCreate: {
      id: 'uuid',
      createdAt: 'now',
      lastSeenAt: 'now',
    },
  }),
  touchLastSeen: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['lastSeenAt'],
  }),
  listByUserId: op.lookup({
    fields: { userId: 'param:userId', tenantId: 'param:tenantId' },
    returns: 'many',
  }),
  findByDevice: op.lookup({
    fields: { userId: 'param:userId', tenantId: 'param:tenantId', deviceId: 'param:deviceId' },
    returns: 'one',
  }),
});
