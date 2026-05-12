/**
 * Package-authoring entity modules for the push entities.
 *
 * Built lazily via `buildPushEntityModules(...)` so the caller can capture the
 * resolved adapter instances at boot time through the `wiring.onAdapter`
 * callbacks. The PushSubscription module additionally injects an
 * `upsertByDevice` create transform that mirrors the legacy manifest behavior
 * — POST /push/subscriptions performs an upsert by `(userId, tenantId, deviceId)`.
 *
 * @internal
 */
import { entity } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { PushDelivery } from './pushDelivery';
import { PushSubscription } from './pushSubscription';
import { PushTopic } from './pushTopic';
import { PushTopicMembership } from './pushTopicMembership';
import {
  pushDeliveryFactories,
  pushSubscriptionFactories,
  pushTopicFactories,
  pushTopicMembershipFactories,
} from './factories';
import { pushDeliveryOperations } from './pushDelivery';
import { pushSubscriptionOperations } from './pushSubscription';
import { pushTopicOperations } from './pushTopic';
import { pushTopicMembershipOperations } from './pushTopicMembership';
import type { PushRouterRepos } from '../router';

/**
 * Wrap the PushSubscription adapter so the entity's POST create path performs
 * an upsert-by-device instead of a plain insert. Mirrors the legacy manifest's
 * `push.subscription.upsertOnCreate` adapter transform.
 */
function applySubscriptionUpsertTransform(adapter: BareEntityAdapter): BareEntityAdapter {
  const subs = adapter as unknown as PushRouterRepos['subscriptions'];
  const wrapped: BareEntityAdapter = {
    ...adapter,
    create: async input =>
      subs.upsertByDevice({
        ...(input as Record<string, unknown>),
        lastSeenAt: new Date(),
      }),
  };
  return wrapped;
}

/**
 * Build the four push entity modules wired to share their resolved adapters
 * with the caller through `onAdapter` callbacks. Each call yields a fresh
 * set — closures captured by `onAdapter` are caller-owned, so multiple package
 * instances stay isolated (Rule 3).
 */
export function buildPushEntityModules(callbacks: {
  onSubscriptions: (adapter: BareEntityAdapter) => void;
  onTopics: (adapter: BareEntityAdapter) => void;
  onTopicMemberships: (adapter: BareEntityAdapter) => void;
  onDeliveries: (adapter: BareEntityAdapter) => void;
}) {
  // PushSubscription uses manual wiring so the entity's POST /subscriptions
  // create route receives the upsert-wrapped adapter, not the bare adapter.
  // (The factories-mode `onAdapter` callback only sees the post-resolution
  // adapter — it cannot influence what the entity routes use.)
  const pushSubscriptionModule = entity({
    config: PushSubscription,
    operations: pushSubscriptionOperations,
    path: 'subscriptions',
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const base = pushSubscriptionFactories[storeType](infra) as unknown as BareEntityAdapter;
        const wrapped = applySubscriptionUpsertTransform(base);
        callbacks.onSubscriptions(wrapped);
        return wrapped;
      },
    },
  });

  const pushTopicModule = entity({
    config: PushTopic,
    operations: pushTopicOperations,
    wiring: {
      mode: 'factories',
      factories: pushTopicFactories,
      onAdapter: callbacks.onTopics,
    },
  });

  const pushTopicMembershipModule = entity({
    config: PushTopicMembership,
    operations: pushTopicMembershipOperations,
    wiring: {
      mode: 'factories',
      factories: pushTopicMembershipFactories,
      onAdapter: callbacks.onTopicMemberships,
    },
  });

  const pushDeliveryModule = entity({
    config: PushDelivery,
    operations: pushDeliveryOperations,
    path: 'deliveries',
    wiring: {
      mode: 'factories',
      factories: pushDeliveryFactories,
      onAdapter: callbacks.onDeliveries,
    },
  });

  return {
    pushSubscriptionModule,
    pushTopicModule,
    pushTopicMembershipModule,
    pushDeliveryModule,
  };
}
