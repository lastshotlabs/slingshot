import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

/**
 * Manifest-backed outbound webhook endpoint.
 */
export const WebhookEndpointEntity = defineEntity('WebhookEndpoint', {
  namespace: 'webhooks',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    ownerType: field.enum(['tenant', 'user', 'app', 'system'] as const),
    ownerId: field.string(),
    tenantId: field.string({ optional: true }),
    url: field.string(),
    secret: field.string(),
    subscriptions: field.json(),
    // Legacy storage shadow used only for explicit startup migration.
    events: field.stringArray({ optional: true }),
    enabled: field.boolean({ default: true }),
    /**
     * Per-endpoint HTTP delivery timeout in milliseconds. When set, overrides
     * the plugin-wide `deliveryTimeoutMs` default. Must be a positive integer
     * <= 120_000 (2 minutes); validated at the manifest runtime boundary.
     */
    deliveryTimeoutMs: field.integer({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['tenantId']),
    index(['ownerType', 'ownerId']),
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
