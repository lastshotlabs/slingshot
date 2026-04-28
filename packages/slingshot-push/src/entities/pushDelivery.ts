import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/** Entity definition for one delivery attempt against one subscription. */
export const PushDelivery = defineEntity('PushDelivery', {
  namespace: 'push',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ default: '' }),
    userId: field.string(),
    subscriptionId: field.string(),
    platform: field.enum(['web', 'ios', 'android'] as const),
    notificationId: field.string({ optional: true }),
    providerMessageId: field.string({ optional: true }),
    providerIdempotencyKey: field.string({ optional: true }),
    status: field.enum(['pending', 'sent', 'delivered', 'failed'] as const, { default: 'pending' }),
    failureReason: field.enum(
      [
        'invalidToken',
        'rateLimited',
        'payloadTooLarge',
        'transient',
        'permanent',
        'repositoryFailure',
      ] as const,
      {
        optional: true,
      },
    ),
    attempts: field.integer({ default: 0 }),
    sentAt: field.date({ optional: true }),
    deliveredAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['subscriptionId']),
    index(['notificationId']),
    index(['tenantId', 'userId', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['create', 'update', 'delete', 'list'],
    dataScope: [
      { field: 'userId', from: 'ctx:actor.id', applyTo: ['get'] },
      { field: 'tenantId', from: 'ctx:tenantId', applyTo: ['get'] },
    ],
  },
});

/** Generated operations for push delivery lifecycle transitions. */
export const pushDeliveryOperations = defineOperations(PushDelivery, {
  markSent: op.transition({
    match: { id: 'param:id' },
    field: 'status',
    from: ['pending'],
    to: 'sent',
    set: { sentAt: 'now', providerMessageId: 'param:providerMessageId' },
    returns: 'entity',
  }),
  markDelivered: op.transition({
    match: { id: 'param:id', userId: 'param:actor.id' },
    field: 'status',
    from: ['sent'],
    to: 'delivered',
    set: { deliveredAt: 'now' },
    returns: 'entity',
  }),
  markFailed: op.transition({
    match: { id: 'param:id' },
    field: 'status',
    from: ['pending', 'sent'],
    to: 'failed',
    set: { failureReason: 'param:failureReason' },
    returns: 'entity',
  }),
  incrementAttempts: op.increment({
    match: { id: 'param:id' },
    field: 'attempts',
  }),
  listByNotificationId: op.lookup({
    fields: { notificationId: 'param:notificationId' },
    returns: 'many',
  }),
});
