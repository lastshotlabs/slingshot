import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Manifest-backed delivery record for outbound webhook attempts.
 */
export const WebhookDeliveryEntity = defineEntity('WebhookDelivery', {
  namespace: 'webhooks',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    endpointId: field.string(),
    event: field.string(),
    eventId: field.string(),
    occurredAt: field.date(),
    subscriber: field.json(),
    sourceScope: field.json({ optional: true }),
    projectedPayload: field.string(),
    status: field.enum(['pending', 'delivered', 'failed', 'dead'] as const, {
      default: 'pending',
    }),
    attempts: field.integer({ default: 0 }),
    nextRetryAt: field.date({ optional: true }),
    lastAttempt: field.json({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['endpointId']),
    index(['tenantId', 'createdAt'], { direction: 'desc' }),
    index(['tenantId', 'status', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['create', 'update', 'delete'],
    get: { middleware: ['webhooksAdminGuard'] },
    list: { middleware: ['webhooksAdminGuard'] },
    dataScope: [
      { field: 'tenantId', from: 'ctx:tenantId', applyTo: ['list', 'get'] },
      { field: 'endpointId', from: 'param:endpointId', applyTo: ['list', 'get'] },
    ],
    middleware: { webhooksAdminGuard: true },
  },
});

/**
 * Internal delivery operations used by queue orchestration.
 */
export const webhookDeliveryOperations = defineOperations(WebhookDeliveryEntity, {
  transition: op.custom({}),
});
