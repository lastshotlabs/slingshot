import type { EventKey } from './eventDefinition';
import type { EventEnvelope } from './eventEnvelope';
import { createRawEventEnvelope, isEventEnvelope } from './eventEnvelope';
import { validateEventPayload } from './eventSchemaRegistry';
import type { EventBusSerializationOptions, ValidationMode } from './eventSerializer';

/**
 * Central event map for all built-in Slingshot events.
 *
 * Typed key → payload pairs consumed by `SlingshotEventBus`. Plugin packages extend
 * this map via TypeScript module augmentation in their own `events.ts` file — never
 * by modifying this interface directly.
 *
 * @example
 * ```ts
 * // Augment from a plugin package:
 * declare module '@lastshotlabs/slingshot-core' {
 *   interface SlingshotEventMap {
 *     'my-plugin:thing.created': { id: string; tenantId: string };
 *   }
 * }
 * ```
 */
export interface SlingshotEventMap {
  // Framework lifecycle
  'app:ready': { plugins: string[] };
  'app:shutdown': { signal: 'SIGTERM' | 'SIGINT' };

  // Security events — auth lifecycle
  'security.auth.login.success': {
    userId: string;
    sessionId?: string;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.login.failure': {
    identifier?: string;
    reason?: string;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.login.blocked': {
    identifier?: string;
    userId?: string;
    reason?: 'lockout' | 'stuffing' | 'suspended';
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.register.success': {
    userId: string;
    email?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.register.failure': { meta?: Record<string, unknown> };
  'security.auth.register.concealed': { meta?: Record<string, unknown> };
  'security.auth.logout': { sessionId?: string; userId?: string };
  'security.auth.account.locked': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.suspended': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.unsuspended': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.deleted': { userId: string; meta?: Record<string, unknown> };
  'security.auth.session.created': { userId: string; sessionId: string };
  'security.auth.session.fingerprint_mismatch': {
    userId: string;
    sessionId: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.session.revoked': {
    userId: string;
    sessionId: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.password.reset': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.password.change': { userId: string };
  'security.auth.mfa.setup': { userId?: string };
  'security.auth.mfa.verify.success': { userId?: string };
  'security.auth.mfa.verify.failure': { userId?: string; method?: string; ip?: string };
  'security.auth.step_up.success': { userId: string };
  'security.auth.step_up.failure': { userId: string };
  'security.auth.oauth.linked': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.oauth.unlinked': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.oauth.reauthed': {
    userId?: string;
    sessionId?: string;
    meta?: Record<string, unknown>;
  };

  // Security events — infrastructure
  'security.rate_limit.exceeded': { key?: string; ip?: string; meta?: Record<string, unknown> };
  'security.credential_stuffing.detected': {
    type?: 'ip' | 'account';
    key?: string;
    count?: number;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.csrf.failed': { ip?: string; path?: string; meta?: Record<string, unknown> };
  'security.breached_password.detected': { meta?: Record<string, unknown> };
  'security.breached_password.api_failure': { meta?: Record<string, unknown> };

  // Security events — admin actions
  'security.admin.role.changed': { userId?: string; meta?: Record<string, unknown> };
  'security.admin.user.modified': { userId?: string; meta?: Record<string, unknown> };
  'security.admin.user.deleted': { userId?: string; meta?: Record<string, unknown> };

  // Auth domain events
  'auth:user.created': { userId: string; email?: string; tenantId?: string | null };
  'auth:user.deleted': { userId: string; tenantId?: string };
  'auth:login': { userId: string; sessionId: string; tenantId?: string };
  'auth:logout': { userId: string; sessionId: string };
  'auth:email.verified': { userId: string; email: string };
  'auth:password.reset.requested': { userId: string; email: string };
  'auth:account.deletion.scheduled': {
    userId: string;
    cancelToken: string;
    gracePeriodSeconds: number;
  };
  'auth:mfa.enabled': { userId: string; method: 'totp' | 'email-otp' | 'webauthn' };
  'auth:mfa.disabled': { userId: string; method?: 'totp' | 'email-otp' | 'webauthn' };

  // Delivery events — mail-plugin-only payloads, token-bearing
  'auth:delivery.email_verification': { email: string; token: string; userId: string };
  'auth:delivery.password_reset': { email: string; token: string };
  'auth:delivery.magic_link': { identifier: string; token: string; link: string };
  'auth:delivery.email_otp': { email: string; code: string };
  'auth:delivery.account_deletion': {
    userId: string;
    email: string;
    cancelToken: string;
    gracePeriodSeconds: number;
  };
  'auth:delivery.welcome': { email: string; identifier: string };
  'auth:delivery.org_invitation': {
    email: string;
    orgName: string;
    invitationLink: string;
    expiryDays: number;
  };
}

// Plugin packages extend SlingshotEventMap via module augmentation in their own events.ts.
// Example: slingshot-community augments with community:* events,
//          slingshot-push augments with push:* events.

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
  off(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}

/**
 * Extracts the subset of `SlingshotEventMap` keys that belong to the `security.*` namespace.
 * Used to type-constrain the `SECURITY_EVENT_TYPES` array and SSE security filters.
 */
export type SecurityEventKey = Extract<keyof SlingshotEventMap, `security.${string}`>;

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
   * @returns `void`. A no-op if the listener was never registered or was already removed.
   */
  off<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void,
  ): void;
  /** Unregister a dynamically named event listener. */
  off(event: string, listener: (payload: unknown) => void): void;
  /**
   * Unregister a previously registered envelope listener.
   */
  offEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): void;
  /** Unregister a dynamically named envelope listener. */
  offEnvelope(event: string, listener: (envelope: EventEnvelope) => void): void;
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

  constructor(serializationOpts?: EventBusSerializationOptions) {
    this.registry = serializationOpts?.schemaRegistry;
    this.validation = serializationOpts?.validation ?? 'off';
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
          ) as SlingshotEventMap[K],
        );
    const fns = this.envelopeListeners.get(event as string);
    if (!fns) return;
    for (const fn of Array.from(fns)) {
      let result: void | Promise<void>;
      try {
        result = fn(envelope as EventEnvelope);
      } catch (err) {
        console.error(`[SlingshotEventBus] listener error on event "${event}":`, err);
        continue;
      }
      const p = Promise.resolve(result);
      this.pendingHandlers.add(p);
      p.catch((err: unknown) => {
        console.error(`[SlingshotEventBus] listener error on event "${event}":`, err);
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
      console.warn(
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
  ): void {
    const wrappers = this.payloadListenerWrappers.get(event as string);
    const wrapper = wrappers?.get(listener as (payload: unknown) => void | Promise<void>);
    if (!wrapper) {
      return;
    }
    wrappers?.delete(listener as (payload: unknown) => void | Promise<void>);
    if (wrappers?.size === 0) {
      this.payloadListenerWrappers.delete(event as string);
    }
    this.offEnvelope(event, wrapper as (envelope: EventEnvelope<K>) => void);
  }

  offEnvelope<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): void {
    this.envelopeListeners
      .get(event as string)
      ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
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
