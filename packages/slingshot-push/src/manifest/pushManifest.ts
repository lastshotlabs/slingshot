import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { PushDelivery, pushDeliveryOperations } from '../entities/pushDelivery';
import { PushSubscription, pushSubscriptionOperations } from '../entities/pushSubscription';
import { PushTopic, pushTopicOperations } from '../entities/pushTopic';
import {
  PushTopicMembership,
  pushTopicMembershipOperations,
} from '../entities/pushTopicMembership';

/**
 * Manifest export for the persisted Slingshot push resources.
 *
 * Provider dispatch, formatter compilation, delivery routing, and topic
 * orchestration remain imperative in `createPushPlugin()`. This manifest owns
 * the persisted entity bootstrap path only.
 */
export const pushManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'push',
  hooks: {
    afterAdapters: [{ handler: 'push.captureAdapters' }],
  },
  entities: {
    PushSubscription: entityConfigToManifestEntry(PushSubscription, {
      operations: pushSubscriptionOperations.operations,
      routePath: 'subscriptions',
      adapterTransforms: [{ handler: 'push.subscription.upsertOnCreate' }],
    }),
    PushTopic: entityConfigToManifestEntry(PushTopic, {
      operations: pushTopicOperations.operations,
    }),
    PushTopicMembership: entityConfigToManifestEntry(PushTopicMembership, {
      operations: pushTopicMembershipOperations.operations,
    }),
    PushDelivery: entityConfigToManifestEntry(PushDelivery, {
      operations: pushDeliveryOperations.operations,
      routePath: 'deliveries',
    }),
  },
};
