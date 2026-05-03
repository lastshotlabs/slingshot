import { createRawEventEnvelope, isEventEnvelope } from './eventEnvelope';
import type { SecurityEventKey, SlingshotEventMap } from './eventMap';
import { validateEventPayload } from './eventSchemaRegistry';
import type { EventBusSerializationOptions, ValidationMode } from './eventSerializer';
import type { EventEnvelope, EventKey } from './eventTypes';
import type { Logger } from './observability/logger';

// Plugin packages extend SlingshotEventMap via module augmentation in their own events.ts.
// Example: slingshot-community augments with community:* events,
//          slingshot-push augments with push:* events.
export type { SlingshotEventMap, SecurityEventKey } from './eventMap';

/**
 * Narrow, untyped view of the event bus for string-keyed subscriptions.
 *
 * Plugins that subscribe to dynamically named events (e.g. `entity:${storageName}.created`)
 * cast the typed `SlingshotEventBus` to this interface rather than widening the global
 * `SlingshotEventMap`. This keeps type widening local per rule 12.
 *
 * Defined here once so every consumer imports the same shape (rule 6). Use `Pick` to
 * narrow further when a module only needs `emit` or only needs `on`/`off`.
 *
 * @example
 * ```ts
 * import type { DynamicEventBus } from '@lastshotlabs/slingshot-core';
 *
 * const dynamicBus = bus as unknown as DynamicEventBus;
 * dynamicBus.on('entity:posts.created', (payload) => { ... });
 * ```
 */
export interface DynamicEventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
  off(event: string, handler: (payload: unknown) => void | Promise<void>): boolean;
}

/**
 * Complete list of all `security.*` event keys defined in `SlingshotEventMap`.
 *
 * Used by the audit log plugin to identify events that must never
 * reach browser clients. The array is frozen and typed as `ReadonlyArray<SecurityEventKey>`.
 */
export const SECURITY_EVENT_TYPES: ReadonlyArray<SecurityEventKey> = [
  'security.auth.login.success',
  'security.auth.login.failure',
  'security.auth.login.blocked',
  'security.auth.register.success',
  'security.auth.register.failure',
  'security.auth.register.concealed',
  'security.auth.logout',
  'security.auth.account.locked',
  'security.auth.account.suspended',
  'security.auth.account.unsuspended',
  'security.auth.account.deleted',
  'security.auth.session.created',
  'security.auth.session.revoked',
  'security.auth.password.reset',
  'security.auth.password.change',
  'security.auth.mfa.setup',
  'security.auth.mfa.verify.success',
  'security.auth.mfa.verify.failure',
  'security.auth.step_up.success',
  'security.auth.step_up.failure',
  'security.auth.oauth.linked',
  'security.auth.oauth.unlinked',
  'security.auth.oauth.reauthed',
  'security.rate_limit.exceeded',
  'security.credential_stuffing.detected',
  'security.csrf.failed',
  'security.breached_password.detected',
  'security.breached_password.api_failure',
  'security.admin.role.changed',
  'security.admin.user.modified',
  'security.admin.user.deleted',
] as const;

/**
 * Options for `SlingshotEventBus.on()` subscriptions.
 *
 * @remarks
 * The `InProcessAdapter` does not support durable subscriptions — registering one
 * logs a warning and degrades to a normal (non-durable) subscription. Durable support
 * requires a queue-backed adapter (e.g., Redis Streams or BullMQ).
 */
export interface SubscriptionOpts {
  /**
   * When `true`, the subscription survives process restarts and replays missed events.
   * Requires `name` to be provided. Not supported by `InProcessAdapter`.
   */
  durable?: boolean;
  /** REQUIRED when durable: true — runtime error thrown if missing */
  name?: string;
}

/**
 * The typed in-process event bus shared across all Slingshot plugins.
 *
 * Each `createApp()` call produces its own bus instance attached to `SlingshotContext.bus`.
 * Plugins subscribe and emit events through this interface without depending on a specific
 * implementation (in-process, Redis Streams, etc.).
 *
 * @remarks
 * Server-side policy consumers should prefer `onEnvelope()` so they can inspect
 * canonical metadata such as scope and exposure without re-deriving it from payloads.
 *
 * @example
 * ```ts
 * const bus = ctx.bus;
 * bus.on('auth:user.created', ({ userId }) => {
 *   console.log('New user:', userId);
 * });
 * bus.emit('auth:user.created', { userId: 'usr_123', tenantId: null });
 * ```
 */
export interface SlingshotEventBus {
  /**
   * Emit an event with a typed payload. All registered listeners are called synchronously;
   * async listeners are tracked via `pendingHandlers` and do not block the emitter.
   * @param event - The event key (must exist in `SlingshotEventMap` or an augmentation).
   * @param payload - The typed payload for this event key.
   * @returns `void` — emit is fire-and-forget. Use `bus.drain()` in tests to await
   *   all in-flight async handlers before making assertions.
   */
  emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void;
  /** Emit a dynamically named event (for plugin-defined event patterns). */
  emit(event: string, payload: unknown): void;
  /**
   * Register a listener for an event.
   * @param event - The event key to subscribe to.
   * @param listener - Called with the typed payload each time the event fires.
   * @param opts - Optional subscription options (durability, name).
   * @returns `void`. The subscription is active immediately after this call returns.
   *   Call `off()` with the same function reference to unsubscribe.
   */
  on<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void;
  /** Subscribe to a dynamically named event (for plugin-defined event patterns). */
  on(
    event: string,
    listener: (payload: unknown) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void;
  /**
   * Register an envelope listener for an event.
   * Infrastructure consumers use this to access canonical metadata such as scope.
   */
  onEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void;
  /** Subscribe to a dynamically named event envelope. */
  onEnvelope(
    event: string,
    listener: (envelope: EventEnvelope) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void;
  /**
   * Unregister a previously registered listener.
   * @param event - The event key.
   * @param listener - The exact listener function reference to remove.
   * @returns `true` if a matching listener was found and removed, `false` if
   *   no matching listener was registered (allows callers to detect a stale
   *   reference or double-unsubscribe).
   */
  off<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void,
  ): boolean;
  /** Unregister a dynamically named event listener. */
  off(event: string, listener: (payload: unknown) => void): boolean;
  /**
   * Unregister a previously registered envelope listener.
   * @returns `true` if a matching envelope listener was found and removed,
   *   `false` otherwise.
   */
  offEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): boolean;
  /** Unregister a dynamically named envelope listener. */
  offEnvelope(event: string, listener: (envelope: EventEnvelope) => void): boolean;
  /**
   * Drain in-flight handlers, remove listeners, and release resources on graceful shutdown.
   *
   * Implementations should stop accepting new deliveries before awaiting any already-running
   * async handlers so shutdown resolves only after the current bus work has quiesced.
   */
  shutdown?(): Promise<void>;
}

/**
 * In-process `SlingshotEventBus` implementation.
 *
 * All listeners run in the same process, in the same event loop. Async listeners
 * are fire-and-forget from the emitter's perspective — errors are caught and logged.
 * Use `drain()` in tests to wait for all in-flight async handlers to settle.
 *
 * @remarks
 * `InProcessAdapter` does not support durable subscriptions. Durable subscription
 * requests degrade to non-durable with a console warning.
 *
 * For production multi-instance deployments, swap this for a queue-backed adapter
 * (e.g., Redis Streams).
 *
 * @example
 * ```ts
 * import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const bus = new InProcessAdapter();
 * bus.on('auth:user.created', ({ userId }) => console.log(userId));
 * bus.emit('auth:user.created', { userId: 'usr_1', tenantId: null });
 * await bus.drain(); // wait for async handlers in tests
 * ```
 */
export class InProcessAdapter implements SlingshotEventBus {
  private envelopeListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void | Promise<void>>
  >();
  private payloadListenerWrappers = new Map<
    string,
    Map<
      (payload: unknown) => void | Promise<void>,
      (envelope: EventEnvelope) => void | Promise<void>
    >
  >();
  private pendingHandlers = new Set<Promise<void>>();
  private readonly registry?: EventBusSerializationOptions['schemaRegistry'];
  private readonly validation: ValidationMode;
  private readonly logger?: Logger;

  constructor(serializationOpts?: EventBusSerializationOptions, logger?: Logger) {
    this.registry = serializationOpts?.schemaRegistry;
    this.validation = serializationOpts?.validation ?? 'off';
    this.logger = logger;
  }

  emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
    const envelope = isEventEnvelope(payload, event)
      ? payload
      : createRawEventEnvelope(
          event as EventKey,
          validateEventPayload(
            event as string,
            payload,
            this.registry,
            this.validation,
            this.logger,
          ) as SlingshotEventMap[K],
        );
    const fns = this.envelopeListeners.get(event as string);
    if (!fns) return;
    for (const fn of Array.from(fns)) {
      let result: void | Promise<void>;
      try {
        result = fn(envelope as EventEnvelope);
      } catch (err) {
        const msg = `[SlingshotEventBus] listener error on event "${event}"`;
        if (this.logger) this.logger.error(msg, { event, error: err });
        else console.error(msg, err);
        continue;
      }
      const p = Promise.resolve(result);
      this.pendingHandlers.add(p);
      p.catch((err: unknown) => {
        const msg = `[SlingshotEventBus] listener error on event "${event}"`;
        if (this.logger) this.logger.error(msg, { event, error: err });
        else console.error(msg, err);
      }).finally(() => {
        this.pendingHandlers.delete(p);
      });
    }
  }

  /**
   * Wait for all in-flight async event handlers to settle.
   *
   * @returns A promise that resolves once every async listener spawned by previous
   *   `emit()` calls has either resolved or rejected. Rejected handlers are caught and
   *   logged — this promise itself never rejects.
   *
   * @remarks
   * **Test utility.** Call `await bus.drain()` after emitting events in a test to ensure
   * all side effects (DB writes, outbound requests, state mutations) have completed before
   * making assertions. Not needed in production — handlers that require coordination
   * should use explicit `await` chains or a queue-backed adapter.
   *
   * Only drains handlers that were in-flight at call time. If a handler emits further
   * events while draining, those secondary handlers may not be included. Call `drain()`
   * again if you need to flush secondary emissions.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pendingHandlers]);
  }

  on<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void {
    const key = event as string;
    const wrapper = (envelope: EventEnvelope): void | Promise<void> =>
      listener(envelope.payload as SlingshotEventMap[K]);
    let wrappers = this.payloadListenerWrappers.get(key);
    if (!wrappers) {
      wrappers = new Map();
      this.payloadListenerWrappers.set(key, wrappers);
    }
    wrappers.set(listener as (payload: unknown) => void | Promise<void>, wrapper);
    this.onEnvelope(event, wrapper as (envelope: EventEnvelope<K>) => void | Promise<void>, opts);
  }

  onEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void {
    if (opts?.durable === true) {
      if (!opts.name) {
        throw new Error('SlingshotEventBus: durable subscriptions require a name. Pass opts.name.');
      }
      // InProcessAdapter does not support durable subscriptions — degrade gracefully
      this.logger?.warn(
        '[SlingshotEventBus] InProcessAdapter does not support durable subscriptions — listener registered as non-durable.',
      );
    }
    const key = event as string; // K extends string — safe cast
    if (!this.envelopeListeners.has(key)) this.envelopeListeners.set(key, new Set());
    const listenerSet = this.envelopeListeners.get(key);
    if (listenerSet) listenerSet.add(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  off<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void,
  ): boolean {
    const wrappers = this.payloadListenerWrappers.get(event as string);
    const wrapper = wrappers?.get(listener as (payload: unknown) => void | Promise<void>);
    if (!wrapper) {
      return false;
    }
    wrappers?.delete(listener as (payload: unknown) => void | Promise<void>);
    if (wrappers?.size === 0) {
      this.payloadListenerWrappers.delete(event as string);
    }
    this.offEnvelope(event, wrapper as (envelope: EventEnvelope<K>) => void);
    return true;
  }

  offEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): boolean {
    const set = this.envelopeListeners.get(event as string);
    if (!set) return false;
    return set.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  async shutdown(): Promise<void> {
    this.envelopeListeners.clear();
    this.payloadListenerWrappers.clear();
    await Promise.allSettled([...this.pendingHandlers]);
  }
}

/**
 * Factory function that creates a new `InProcessAdapter` instance.
 *
 * Prefer this over `new InProcessAdapter()` in application code — it returns the
 * `SlingshotEventBus` interface rather than the concrete class, keeping the call site
 * decoupled from the implementation.
 *
 * @returns A fresh `SlingshotEventBus` instance with no shared state.
 *
 * @remarks
 * Each call returns a fully independent instance — listeners, pending handlers, and the
 * listener registrations and pending handler sets are all owned by the returned object and never shared. Calling
 * `createInProcessAdapter()` twice produces two completely isolated buses.
 *
 * @example
 * ```ts
 * import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const bus = createInProcessAdapter();
 * bus.on('my-plugin:item.created', ({ id }) => console.log('created', id));
 * ```
 */
export function createInProcessAdapter(
  serializationOpts?: EventBusSerializationOptions,
): SlingshotEventBus {
  return new InProcessAdapter(serializationOpts);
}
