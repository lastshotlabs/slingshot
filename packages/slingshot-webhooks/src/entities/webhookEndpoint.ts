import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Manifest-backed outbound webhook endpoint.
 */
export const WebhookEndpointEntity = defineEntity('WebhookEndpoint', {
  namespace: 'webhooks',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    url: field.string(),
    secret: field.string(),
    events: field.stringArray(),
    enabled: field.boolean({ default: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['tenantId']),
    index(['tenantId', 'enabled']),
    index(['tenantId', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    create: { middleware: ['webhooksAdminGuard'] },
    list: { middleware: ['webhooksAdminGuard'] },
    get: { middleware: ['webhooksAdminGuard'] },
    update: { middleware: ['webhooksAdminGuard'] },
    delete: { middleware: ['webhooksAdminGuard'] },
    dataScope: [
      {
        field: 'tenantId',
        from: 'ctx:tenantId',
        applyTo: ['create', 'list', 'get', 'update', 'delete'],
      },
    ],
    middleware: { webhooksAdminGuard: true },
  },
});

/**
 * Internal endpoint operations used by webhook orchestration.
 */
export const webhookEndpointOperations = defineOperations(WebhookEndpointEntity, {
  findForEvent: op.custom({}),
});
