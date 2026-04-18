import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { WebhookDeliveryEntity, webhookDeliveryOperations } from '../entities/webhookDelivery';
import { WebhookEndpointEntity, webhookEndpointOperations } from '../entities/webhookEndpoint';

/**
 * Declarative manifest for webhook persistence.
 */
export const webhooksManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'webhooks',
  hooks: {
    afterAdapters: [{ handler: 'webhooks.captureAdapters' }],
  },
  entities: {
    WebhookEndpoint: entityConfigToManifestEntry(WebhookEndpointEntity, {
      operations: webhookEndpointOperations.operations,
      routePath: 'endpoints',
      adapterTransforms: [{ handler: 'webhooks.endpoint.runtime' }],
      operationOverrides: {
        findForEvent: {
          kind: 'custom',
          handler: 'webhooks.endpoint.findForEvent',
        },
      },
    }),
    WebhookDelivery: entityConfigToManifestEntry(WebhookDeliveryEntity, {
      operations: webhookDeliveryOperations.operations,
      routePath: 'endpoints/:endpointId/deliveries',
      adapterTransforms: [{ handler: 'webhooks.delivery.runtime' }],
      operationOverrides: {
        transition: {
          kind: 'custom',
          handler: 'webhooks.delivery.transition',
        },
      },
    }),
  },
};
