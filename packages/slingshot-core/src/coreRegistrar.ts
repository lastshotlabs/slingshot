import type {
  CacheAdapter,
  CacheStoreName,
  CoreRegistrar,
  CoreRegistrarSnapshot,
  EmailTemplate,
  FingerprintBuilder,
  RateLimitAdapter,
  RequestActorResolver,
  RouteAuthRegistry,
} from './coreContracts';
import type { IdentityResolver } from './identity';

export type { CoreRegistrar, CoreRegistrarSnapshot };

/**
 * Create a `CoreRegistrar` / drain pair for collecting auth-boundary dependencies
 * during the plugin lifecycle before they are committed to the `SlingshotContext`.
 *
 * The auth plugin calls `registrar.set*` and `registrar.add*` methods during its
 * `setupPost` phase. `createApp()` then calls `drain()` to snapshot all registered
 * values and write them immutably into the `SlingshotContext`.
 *
 * @returns An object with:
 *   - `registrar` — the `CoreRegistrar` passed to plugins during `setupPost`.
 *   - `drain()` — a function that snapshots all registered values into a
 *     `CoreRegistrarSnapshot`. See drain remarks below.
 *
 * @remarks
 * **Closure semantics:** all mutable state (`routeAuth`, `actorResolver`, etc.) is owned
 * by the closure created by `createCoreRegistrar()`. The `registrar` object holds
 * references to setter functions that mutate this closure state. This is intentional —
 * no module-level singletons, no shared state between app instances.
 *
 * **Drain idempotency:** `drain()` can be called multiple times safely. Each call returns
 * a new `CoreRegistrarSnapshot` object with a snapshot of the current closure state at
 * call time. The first `drain()` seals the registrar against any further mutation:
 * later `set*` / `add*` calls throw so plugins cannot continue mutating bootstrap-owned
 * framework dependencies after finalization. In practice, `createApp()` calls `drain()`
 * exactly once, after all `setupPost` hooks have completed.
 *
 * Call `createCoreRegistrar()` once per `createApp()` invocation — never share a
 * registrar across app instances.
 *
 * @example
 * **Framework bootstrap (normal usage):**
 * ```ts
 * import { createCoreRegistrar } from '@lastshotlabs/slingshot-core';
 *
 * const { registrar, drain } = createCoreRegistrar();
 *
 * // Pass registrar to plugins during their setupPost phase:
 * for (const plugin of plugins) {
 *   await plugin.setupPost?.({ app, registrar, ctx });
 * }
 *
 * // After all plugins have registered their deps, drain once to commit to context:
 * const snapshot = drain();
 * // snapshot.routeAuth, snapshot.actorResolver, snapshot.rateLimitAdapter, etc.
 * ```
 *
 * @example
 * **Test isolation (drain verifies registration):**
 * ```ts
 * import { createCoreRegistrar } from '@lastshotlabs/slingshot-core';
 * import { myAuthPlugin } from './myAuthPlugin';
 *
 * test('auth plugin registers routeAuth', async () => {
 *   const app = new Hono();
 *   const { registrar, drain } = createCoreRegistrar();
 *
 *   // Each test creates a fresh registrar — no shared module-level state.
 *   await myAuthPlugin.setupPost({ app, registrar });
 *
 *   const snapshot = drain();
 *   expect(snapshot.routeAuth).not.toBeNull();
 *   expect(snapshot.actorResolver).not.toBeNull();
 * });
 * ```
 */
export function createCoreRegistrar(): {
  registrar: CoreRegistrar;
  drain(): CoreRegistrarSnapshot;
} {
  let sealed = false;
  let identityResolver: IdentityResolver | null = null;
  let routeAuth: RouteAuthRegistry | null = null;
  let actorResolver: RequestActorResolver | null = null;
  let rateLimitAdapter: RateLimitAdapter | null = null;
  let fingerprintBuilder: FingerprintBuilder | null = null;
  const cacheAdapters = new Map<CacheStoreName, CacheAdapter>();
  const emailTemplates = new Map<string, EmailTemplate>();

  function assertWritable(method: string): void {
    if (sealed) {
      throw new Error(
        `[slingshot] CoreRegistrar is finalized; ${method}() cannot be called after drain().`,
      );
    }
  }

  const registrar: CoreRegistrar = {
    setIdentityResolver(resolver) {
      assertWritable('setIdentityResolver');
      identityResolver = resolver;
    },
    setRouteAuth(registry) {
      assertWritable('setRouteAuth');
      routeAuth = registry;
    },
    setRequestActorResolver(resolver) {
      assertWritable('setRequestActorResolver');
      actorResolver = resolver;
    },
    setRateLimitAdapter(adapter) {
      assertWritable('setRateLimitAdapter');
      rateLimitAdapter = adapter;
    },
    setFingerprintBuilder(builder) {
      assertWritable('setFingerprintBuilder');
      fingerprintBuilder = builder;
    },
    addCacheAdapter(store, adapter) {
      assertWritable('addCacheAdapter');
      cacheAdapters.set(store, adapter);
    },
    addEmailTemplates(templates) {
      assertWritable('addEmailTemplates');
      for (const [key, template] of Object.entries(templates)) {
        emailTemplates.set(key, template);
      }
    },
  };

  return {
    registrar: Object.freeze(registrar),
    drain() {
      sealed = true;
      return {
        identityResolver,
        routeAuth,
        actorResolver,
        rateLimitAdapter,
        fingerprintBuilder,
        cacheAdapters: new Map(cacheAdapters),
        emailTemplates: new Map(emailTemplates),
      };
    },
  };
}
