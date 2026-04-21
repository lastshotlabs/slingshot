import type { SlingshotEventBus, SlingshotEventMap } from './eventBus';
import type { EventEnvelope } from './eventEnvelope';

/**
 * Configuration for `createRouterAdapter`.
 *
 * A default bus handles all events not matched by a namespace prefix.
 * Namespace prefixes allow routing specific event families to dedicated buses
 * (e.g., community events to a Redis-backed adapter while security events stay in-process).
 *
 * @example
 * ```ts
 * const opts: RouterAdapterOptions = {
 *   default: inProcessBus,
 *   namespaces: { 'community:': redisBus },
 * };
 * ```
 */
export interface RouterAdapterOptions {
  /** The fallback bus for any event not matched by a namespace entry. */
  default: SlingshotEventBus;
  /**
   * Event key prefix → bus mapping.
   * The longest matching prefix wins (e.g., `community:delivery.` beats `community:`).
   */
  namespaces?: Record<string, SlingshotEventBus>;
}

/**
 * Selects the appropriate backing adapter for a given event key using longest-prefix matching.
 *
 * The algorithm scans all entries in `opts.namespaces` and picks the one whose prefix:
 * 1. Is a prefix of `event` (i.e. `event.startsWith(prefix)`), **and**
 * 2. Is longer than any other matching prefix.
 *
 * If no namespace prefix matches, or if `opts.namespaces` is absent, the default adapter
 * is returned.
 *
 * @param event - The event key to route (e.g. `'community:delivery.email_verification'`).
 * @param opts - Router configuration containing the default adapter and optional namespace map.
 * @returns The `SlingshotEventBus` instance that should handle `event`.
 *
 * @remarks
 * **Tie-breaking:** ties cannot occur in practice because prefix strings in
 * `opts.namespaces` are expected to be uniquely defined. If two entries have identical
 * prefix strings, `Object.entries` iteration order determines which one wins — this is
 * a configuration error, not an intentional tie-break rule.
 *
 * **No caching:** the scan is O(n) on the number of namespace entries for every call to
 * `emit`, `on`, or `off`. In typical deployments there are only a handful of namespaces,
 * so this is negligible.
 *
 * @example
 * ```ts
 * const opts = {
 *   default: inProcessBus,
 *   namespaces: {
 *     'community:':          communityBus,
 *     'community:delivery.': deliveryBus,
 *   },
 * };
 *
 * resolveAdapter('auth:user.created',                opts)  // → inProcessBus  (no match)
 * resolveAdapter('community:thread.created',         opts)  // → communityBus  ('community:' matches)
 * resolveAdapter('community:delivery.email_verify',  opts)  // → deliveryBus   ('community:delivery.' is longer)
 * ```
 */
function resolveAdapter(event: string, opts: RouterAdapterOptions): SlingshotEventBus {
  if (!opts.namespaces) return opts.default;

  // Longest prefix wins
  let bestMatch = '';
  let bestAdapter: SlingshotEventBus | undefined;

  for (const [prefix, adapter] of Object.entries(opts.namespaces)) {
    if (event.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
      bestAdapter = adapter;
    }
  }

  return bestAdapter ?? opts.default;
}

/**
 * Creates a multiplexing `SlingshotEventBus` that routes each event to the appropriate
 * backing adapter based on longest-prefix namespace matching.
 *
 * `emit`, `on`, and `off` are each forwarded to the single adapter that owns the event's
 * namespace. `shutdown` is forwarded to every adapter.
 *
 * @param opts - Default adapter plus optional namespace → adapter overrides.
 * @returns A `SlingshotEventBus` that transparently routes events across multiple adapters.
 *
 * @remarks
 * Use this when you need different backing stores per event domain — for example,
 * community events in a Redis Streams adapter for fan-out, while security events stay
 * in-process. Listeners registered before `createRouterAdapter` is called are attached to
 * the individual adapters, not the router — the router is a dispatch layer only.
 *
 * @example
 * ```ts
 * import { createRouterAdapter, createInProcessAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const inProcess = createInProcessAdapter();
 * const communityBus = createInProcessAdapter();
 *
 * const bus = createRouterAdapter({
 *   default: inProcess,
 *   namespaces: { 'community:': communityBus },
 * });
 *
 * bus.emit('auth:user.created', { userId: 'usr_1', tenantId: null }); // → inProcess
 * bus.emit('community:thread.created', { ... });                       // → communityBus
 * ```
 */
export function createRouterAdapter(opts: RouterAdapterOptions): SlingshotEventBus {
  function allAdapters(): SlingshotEventBus[] {
    const seen = new Set<SlingshotEventBus>();
    seen.add(opts.default);
    if (opts.namespaces) {
      for (const adapter of Object.values(opts.namespaces)) {
        seen.add(adapter);
      }
    }
    return [...seen];
  }

  return {
    emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
      resolveAdapter(event as string, opts).emit(event, payload);
    },

    on<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
      subscriptionOpts?: import('./eventBus').SubscriptionOpts,
    ): void {
      resolveAdapter(event as string, opts).on(event, listener, subscriptionOpts);
    },

    onEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
      subscriptionOpts?: import('./eventBus').SubscriptionOpts,
    ): void {
      resolveAdapter(event as string, opts).onEnvelope(event, listener, subscriptionOpts);
    },

    off<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void,
    ): void {
      resolveAdapter(event as string, opts).off(event, listener);
    },

    offEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void,
    ): void {
      resolveAdapter(event as string, opts).offEnvelope(event, listener);
    },

    async shutdown(): Promise<void> {
      for (const adapter of allAdapters()) {
        await adapter.shutdown?.();
      }
    },
  };
}
