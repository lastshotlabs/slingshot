/**
 * Central event map for all built-in Slingshot events.
 *
 * Typed key → payload pairs consumed by `SlingshotEventBus`. Plugin packages extend
 * this map via TypeScript module augmentation in their own `events.ts` file — never
 * by modifying this interface directly.
 *
 * @remarks
 * Forbidden namespaces (`security.*`, `auth:*`, `community:delivery.*`, `push:*`,
 * `app:*`) cannot be registered as client-safe events. Security and delivery events
 * carry sensitive data (tokens, session IDs, emails) that must never reach browsers.
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

function createReadonlySetView<T>(backing: Set<T>): ReadonlySet<T> {
  const collectValues = <U>(other: ReadonlySetLike<U>): U[] => {
    const values: U[] = [];
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      values.push(next.value);
    }
    return values;
  };

  const view: ReadonlySet<T> = {
    get size() {
      return backing.size;
    },
    has(value: T): boolean {
      return backing.has(value);
    },
    entries(): SetIterator<[T, T]> {
      return backing.entries();
    },
    keys(): SetIterator<T> {
      return backing.keys();
    },
    values(): SetIterator<T> {
      return backing.values();
    },
    forEach(
      callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown,
    ): void {
      backing.forEach((value1, value2) => {
        callbackfn.call(thisArg, value1, value2, view);
      });
    },
    union<U>(other: ReadonlySetLike<U>): Set<T | U> {
      const result = new Set<T | U>(backing);
      for (const value of collectValues(other)) {
        result.add(value);
      }
      return result;
    },
    intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
      const result = new Set<T & U>();
      for (const value of backing) {
        if (other.has(value as unknown as U)) {
          result.add(value as T & U);
        }
      }
      return result;
    },
    difference<U>(other: ReadonlySetLike<U>): Set<T> {
      const result = new Set<T>();
      for (const value of backing) {
        if (!other.has(value as unknown as U)) {
          result.add(value);
        }
      }
      return result;
    },
    symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
      const result = new Set<T | U>();
      for (const value of backing) {
        if (!other.has(value as unknown as U)) {
          result.add(value);
        }
      }
      for (const value of collectValues(other)) {
        if (!backing.has(value as unknown as T)) {
          result.add(value);
        }
      }
      return result;
    },
    isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
      for (const value of backing) {
        if (!other.has(value)) {
          return false;
        }
      }
      return true;
    },
    isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
      for (const value of collectValues(other)) {
        if (!backing.has(value as T)) {
          return false;
        }
      }
      return true;
    },
    isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
      for (const value of backing) {
        if (other.has(value)) {
          return false;
        }
      }
      return true;
    },
    [Symbol.iterator](): SetIterator<T> {
      return backing[Symbol.iterator]();
    },
  };

  return Object.freeze(view);
}

/**
 * Complete list of all `security.*` event keys defined in `SlingshotEventMap`.
 *
 * Used by the audit log plugin and SSE guard to identify events that must never
 * reach browser clients. The array is frozen and typed as `ReadonlyArray<SecurityEventKey>`.
 *
 * @remarks
 * These namespaces are permanently forbidden for client-safe registration because they carry
 * sensitive data that must never be streamed to browsers:
 * - `security.*` — internal audit trail events containing session IDs, user IDs, IP
 *   addresses, authentication failure details, and credential-stuffing signals.
 * - `auth:*` — domain auth events containing `sessionId`, email addresses, and reset tokens.
 * - `community:delivery.*` — delivery metadata (notification payloads, email addresses).
 * - `push:*` — push notification delivery metadata.
 * - `app:*` — server lifecycle signals (`app:ready`, `app:shutdown`) that reveal internal
 *   deployment topology to clients.
 *
 * `registerClientSafeEvents()` enforces these bans at runtime by checking
 * `FORBIDDEN_CLIENT_PREFIXES`. This constant provides a typed enumeration used by the
 * audit log plugin to subscribe to all security events in a single `for...of` loop.
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
 * Built-in event keys safe to stream to browser clients via SSE.
 * Frozen seed — copied into each event bus instance at creation.
 * Instance-scoped mutable set lives on bus.clientSafeKeys.
 *
 * Includes community domain events that are safe for client consumption.
 * Excluded: community:content.reported (reporterId privacy),
 * community:delivery.* (forbidden prefix), and all security/auth/push/app namespaces.
 *
 * Never stream (forbidden namespaces enforced by registerClientSafeEvents):
 * - `security.*`           — internal audit trail
 * - `auth:*`               — sessionId, email, tokens
 * - `community:delivery.*` — delivery metadata
 * - `push:*`               — delivery metadata
 * - `app:*`                — server lifecycle signals
 */
export const BUILTIN_CLIENT_SAFE_KEYS: ReadonlySet<string> = createReadonlySetView(
  new Set<string>([
    'community:container.created',
    'community:container.deleted',
    'community:thread.created',
    'community:thread.published',
    'community:thread.deleted',
    'community:thread.locked',
    'community:thread.unlocked',
    'community:thread.updated',
    'community:thread.pinned',
    'community:thread.unpinned',
    'community:reply.created',
    'community:reply.deleted',
    'community:reaction.added',
    'community:reaction.removed',
    'community:user.banned',
    'community:user.unbanned',
    'community:member.joined',
    'community:member.left',
    'community:moderator.assigned',
    'community:moderator.removed',
  ]),
);

/**
 * A string that has been validated as a safe-to-stream event key.
 *
 * Branded as `string` rather than a nominal type so it passes through `JSON.stringify`
 * and other generic string utilities without ceremony.
 */
export type ClientSafeEventKey = string;

/**
 * Event key namespace prefixes that are always forbidden for client streaming.
 *
 * Any event key that starts with one of these prefixes will be rejected by
 * `registerClientSafeEvents()` and `ensureClientSafeEventKey()`. Forbidden namespaces
 * carry sensitive data — session tokens, delivery metadata, server lifecycle signals.
 */
export const FORBIDDEN_CLIENT_PREFIXES = [
  'security.',
  'auth:',
  'community:delivery.',
  'push:',
  'app:',
] as const;

/**
 * Returns the first entry from `FORBIDDEN_CLIENT_PREFIXES` that `key` starts with,
 * or `undefined` if the key is not in any forbidden namespace.
 *
 * @param key - The event key to test (e.g. `'security.auth.login.success'`).
 * @returns The matching forbidden prefix string (e.g. `'security.'`), or `undefined`.
 *
 * @remarks
 * The check is a simple `startsWith` scan over `FORBIDDEN_CLIENT_PREFIXES` in declaration
 * order. Prefix order does not affect correctness because the prefixes are disjoint —
 * no event key can match more than one forbidden prefix simultaneously.
 */
function getForbiddenClientSafePrefix(key: string): string | undefined {
  return FORBIDDEN_CLIENT_PREFIXES.find(prefix => key.startsWith(prefix));
}

/**
 * Returns a formatted error message if `key` falls within a forbidden client-safe namespace,
 * or `null` if the key is safe to register.
 *
 * @param key - The event key being validated for client-safe registration.
 * @returns A human-readable error string if the key is forbidden, or `null` if it is allowed.
 *
 * @remarks
 * The returned message is intended to be passed directly to `new Error(...)` by
 * `registerClientSafeEvents`. Separating detection from the throw allows the error text to
 * be tested in isolation and keeps `registerClientSafeEvents` concise.
 */
function getClientSafeRegistrationError(key: string): string | null {
  const prefix = getForbiddenClientSafePrefix(key);
  if (!prefix) return null;
  return `Cannot register "${key}" as client-safe: "${prefix}" namespace is forbidden`;
}

// ensureClientSafeEventKey and registerClientSafeEvents are now instance methods
// on SlingshotEventBus — no module-level mutable state.

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
 * Security events (`security.*`) and delivery events (`auth:delivery.*`) are never
 * forwarded to browser clients via SSE. Use `registerClientSafeEvents()` to allow
 * domain events to be streamed, and `ensureClientSafeEventKey()` in SSE config
 * validation to catch misconfigured keys at startup.
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
   * Drain in-flight handlers, remove listeners, and release resources on graceful shutdown.
   *
   * Implementations should stop accepting new deliveries before awaiting any already-running
   * async handlers so shutdown resolves only after the current bus work has quiesced.
   */
  shutdown?(): Promise<void>;

  /**
   * Instance-scoped set of event keys that may be streamed to browser clients via SSE.
   *
   * @remarks
   * This set is mutable during the plugin setup lifecycle — plugins extend it by calling
   * `registerClientSafeEvents()`. After `createServer()` resolves, the set should be
   * treated as effectively frozen: registering new keys after startup may not be respected
   * by SSE endpoints that captured the set at route registration time.
   *
   * Seeded from `BUILTIN_CLIENT_SAFE_KEYS` (community domain events) at construction.
   */
  readonly clientSafeKeys: ReadonlySet<string>;

  /**
   * Register additional event keys as client-safe for SSE streaming.
   * Keys with forbidden prefixes (`security.*`, `auth:*`, `community:delivery.*`,
   * `push:*`, `app:*`) are rejected with a thrown `Error`.
   * @returns `void`. The keys are added to `clientSafeKeys` immediately.
   */
  registerClientSafeEvents(keys: string[]): void;

  /**
   * Validate that a key is registered as client-safe, returning it as a `ClientSafeEventKey`.
   * Throws on forbidden namespaces or if the key has not been registered via
   * `registerClientSafeEvents`.
   * @param key - The event key to validate.
   * @param source - A human-readable description of the call site, included in error messages
   *   (e.g. `'SSE /events config'`). Defaults to `'SSE config'` when omitted.
   * @returns The validated key, typed as `ClientSafeEventKey`.
   */
  ensureClientSafeEventKey(key: string, source?: string): ClientSafeEventKey;
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
 * (e.g., Redis Streams). The constructor accepts `initialClientSafeKeys` to seed
 * the allow-list beyond the built-in community events in `BUILTIN_CLIENT_SAFE_KEYS`.
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
  private listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
  private _clientSafeKeys: Set<string>;
  private readonly clientSafeKeysView: ReadonlySet<string>;
  private pendingHandlers = new Set<Promise<void>>();

  /**
   * @param initialClientSafeKeys - Additional event keys to seed as client-safe.
   *   Defaults to `BUILTIN_CLIENT_SAFE_KEYS`. Pass a custom set to override.
   */
  constructor(initialClientSafeKeys?: Iterable<string>) {
    this._clientSafeKeys = new Set(initialClientSafeKeys ?? BUILTIN_CLIENT_SAFE_KEYS);
    this.clientSafeKeysView = createReadonlySetView(this._clientSafeKeys);
  }

  get clientSafeKeys(): ReadonlySet<string> {
    return this.clientSafeKeysView;
  }

  registerClientSafeEvents(keys: string[]): void {
    for (const key of keys) {
      const error = getClientSafeRegistrationError(key);
      if (error) throw new Error(error);
      this._clientSafeKeys.add(key);
    }
  }

  ensureClientSafeEventKey(key: string, source = 'SSE config'): ClientSafeEventKey {
    const forbiddenPrefix = getForbiddenClientSafePrefix(key);
    if (forbiddenPrefix) {
      throw new Error(
        `[slingshot] ${source}: "${key}" cannot be streamed to clients because the "${forbiddenPrefix}" namespace is forbidden`,
      );
    }
    if (!this._clientSafeKeys.has(key)) {
      throw new Error(
        `[slingshot] ${source}: "${key}" is not registered as client-safe. Call bus.registerClientSafeEvents([...]) before createServer().`,
      );
    }
    return key;
  }

  emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
    const fns = this.listeners.get(event as string);
    if (!fns) return;
    for (const fn of Array.from(fns)) {
      let result: void | Promise<void>;
      try {
        result = fn(payload);
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
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    const listenerSet = this.listeners.get(key);
    if (listenerSet) listenerSet.add(listener as (payload: unknown) => void | Promise<void>);
  }

  off<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (payload: SlingshotEventMap[K]) => void,
  ): void {
    this.listeners
      .get(event as string)
      ?.delete(listener as (payload: unknown) => void | Promise<void>);
  }

  async shutdown(): Promise<void> {
    this.listeners.clear();
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
 * @param initialClientSafeKeys - Optional iterable of event keys to seed as client-safe
 *   in addition to `BUILTIN_CLIENT_SAFE_KEYS`. Useful when a plugin registers its own
 *   domain events before `createServer()` runs.
 * @returns A fresh `SlingshotEventBus` instance with no shared state.
 *
 * @remarks
 * Each call returns a fully independent instance — listeners, pending handlers, and the
 * `clientSafeKeys` set are all owned by the returned object and never shared. Calling
 * `createInProcessAdapter()` twice produces two completely isolated buses.
 *
 * @example
 * ```ts
 * import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const bus = createInProcessAdapter(['my-plugin:item.created']);
 * bus.on('my-plugin:item.created', ({ id }) => console.log('created', id));
 * ```
 */
export function createInProcessAdapter(
  initialClientSafeKeys?: Iterable<string>,
): SlingshotEventBus {
  return new InProcessAdapter(initialClientSafeKeys);
}
