import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityAdapterTransformRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import type { PushRouterRepos } from '../router';

type PushAdapterRefs = Pick<
  PushRouterRepos,
  'subscriptions' | 'topics' | 'topicMemberships' | 'deliveries'
>;

function hasMethod(value: BareEntityAdapter, method: string): boolean {
  return typeof value[method] === 'function';
}

function isSubscriptionRepo(value: unknown): value is PushRouterRepos['subscriptions'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'listByUserId') &&
    hasMethod(adapter, 'findByDevice') &&
    hasMethod(adapter, 'touchLastSeen') &&
    hasMethod(adapter, 'upsertByDevice')
  );
}

function requireSubscriptionRepo(value: BareEntityAdapter): PushRouterRepos['subscriptions'] {
  if (isSubscriptionRepo(value)) {
    return value;
  }
  throw new Error(
    '[slingshot-push] PushSubscription adapter is missing required subscription operations',
  );
}

function isTopicRepo(value: unknown): value is PushRouterRepos['topics'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return hasMethod(adapter, 'ensureByName') && hasMethod(adapter, 'findByName');
}

function requireTopicRepo(value: BareEntityAdapter): PushRouterRepos['topics'] {
  if (isTopicRepo(value)) {
    return value;
  }
  throw new Error('[slingshot-push] PushTopic adapter is missing required topic operations');
}

function isTopicMembershipRepo(value: unknown): value is PushRouterRepos['topicMemberships'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'ensureMembership') &&
    hasMethod(adapter, 'listByTopic') &&
    hasMethod(adapter, 'removeByTopicAndSub') &&
    hasMethod(adapter, 'removeBySubscription')
  );
}

function requireTopicMembershipRepo(value: BareEntityAdapter): PushRouterRepos['topicMemberships'] {
  if (isTopicMembershipRepo(value)) {
    return value;
  }
  throw new Error(
    '[slingshot-push] PushTopicMembership adapter is missing required topic membership operations',
  );
}

function isDeliveryRepo(value: unknown): value is PushRouterRepos['deliveries'] {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return (
    hasMethod(adapter, 'markSent') &&
    hasMethod(adapter, 'markDelivered') &&
    hasMethod(adapter, 'markFailed') &&
    hasMethod(adapter, 'incrementAttempts')
  );
}

function requireDeliveryRepo(value: BareEntityAdapter): PushRouterRepos['deliveries'] {
  if (isDeliveryRepo(value)) {
    return value;
  }
  throw new Error('[slingshot-push] PushDelivery adapter is missing required delivery operations');
}

/**
 * Build the manifest runtime for `pushManifest`.
 *
 * The runtime keeps push persistence declarative while letting the plugin
 * capture resolved adapters for imperative router/provider orchestration.
 *
 * @param onAdaptersReady - Called once all manifest adapters are resolved and transformed.
 * @returns Runtime registries passed to `createEntityPlugin({ manifestRuntime })`.
 */
export function createPushManifestRuntime(
  onAdaptersReady: (adapters: PushAdapterRefs) => void,
): EntityManifestRuntime {
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const hooks = createEntityPluginHookRegistry();

  adapterTransforms.register('push.subscription.upsertOnCreate', adapter => {
    const subscriptions = requireSubscriptionRepo(adapter);
    return {
      ...adapter,
      create: async input => {
        return subscriptions.upsertByDevice({
          ...(input as Record<string, unknown>),
          lastSeenAt: new Date(),
        });
      },
    };
  });

  hooks.register('push.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    onAdaptersReady({
      subscriptions: requireSubscriptionRepo(ctx.adapters.PushSubscription),
      topics: requireTopicRepo(ctx.adapters.PushTopic),
      topicMemberships: requireTopicMembershipRepo(ctx.adapters.PushTopicMembership),
      deliveries: requireDeliveryRepo(ctx.adapters.PushDelivery),
    });
  });

  return {
    adapterTransforms,
    hooks,
  };
}
