import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RESOLVE_TRANSACTION_ENTITY_ADAPTER,
  type StoreInfra,
  type StoreType,
  TransactionCommitError,
  type TransactionEntityAdapterLookup,
  type TransactionEntityAdapterRegistration,
  type TransactionManager,
  TransactionPostCommitError,
  type TransactionPostCommitFailure,
  type TransactionScope,
  TransactionScopeClosedError,
  TransactionScopeInvalidError,
  TransactionScopeMismatchError,
  type TransactionStore,
  TransactionStoreUnsupportedError,
  UnsettledTransactionWorkError,
} from '@lastshotlabs/slingshot-core';

const RESOLVE_SEARCH_SYNC = Symbol.for('slingshot.resolveSearchSync');
const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');
export const ENQUEUE_TRANSACTION_SCOPE_WORK = Symbol.for('slingshot.enqueueTransactionScopeWork');

type ScopePhase = 'open' | 'settling' | 'committing' | 'closed';

interface BufferedEffect {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

interface ScopeState {
  readonly scope: TransactionScope;
  readonly session: FrameworkTransactionBackendSession;
  readonly pending: Set<Promise<unknown>>;
  readonly implicitPending: Set<Promise<unknown>>;
  readonly effects: BufferedEffect[];
  readonly adapters: Map<string, object>;
  readonly methodWrappers: WeakMap<object, Map<PropertyKey, (...args: unknown[]) => unknown>>;
  scopedInfra?: StoreInfra;
  phase: ScopePhase;
  hasImplicitFailure: boolean;
  implicitFailure?: unknown;
}

/** One physical backend transaction opened for a framework scope. */
export interface FrameworkTransactionBackendSession {
  /** Infrastructure view whose selected store accessor is bound to this transaction. */
  readonly storeInfra: StoreInfra;
  /** Commit the physical transaction. */
  commit(): void | Promise<void>;
  /** Roll back the physical transaction. */
  rollback(): void | Promise<void>;
  /** Release the physical backend lease/client exactly once. */
  release(): void | Promise<void>;
  /**
   * Return the first backend error that made this transaction impossible to commit.
   *
   * PostgreSQL uses this after a query error is caught by user code: the server-side
   * transaction remains aborted, so the framework must roll back and reject instead
   * of issuing a misleading COMMIT.
   */
  rollbackOnlyCause?(): { readonly cause: unknown } | null;
}

/** Internal provider implemented by each store that claims scoped rollback support. */
export interface FrameworkTransactionBackendProvider {
  readonly store: TransactionStore;
  open(): FrameworkTransactionBackendSession | Promise<FrameworkTransactionBackendSession>;
}

/** Framework-only extension used by StoreInfra DI hooks. */
export interface FrameworkTransactionManager extends TransactionManager {
  registerEntity(registration: TransactionEntityAdapterRegistration): void;
  resolveEntity(lookup: TransactionEntityAdapterLookup): object;
}

function scopeId(): string {
  return globalThis.crypto.randomUUID();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}

function effectLabel(config: unknown, suffix: string): string {
  const storageName =
    typeof config === 'object' &&
    config !== null &&
    typeof Reflect.get(config, '_storageName') === 'string'
      ? String(Reflect.get(config, '_storageName'))
      : 'entity';
  return `${storageName}:${suffix}`;
}

function bufferSearchSync(state: ScopeState, config: unknown, resolved: unknown): unknown {
  if (typeof resolved !== 'object' || resolved === null) return resolved;
  const sync = resolved as Record<string, unknown>;
  const mode = sync.syncMode;

  if (mode === 'manual') return resolved;

  if (mode === 'event-bus') {
    const eventBus = sync.eventBus;
    if (typeof eventBus !== 'object' || eventBus === null) return resolved;
    const emit = Reflect.get(eventBus, 'emit');
    if (typeof emit !== 'function') return resolved;
    return {
      ...sync,
      ensureReady: async () => {},
      eventBus: {
        emit(event: string, payload: unknown): void {
          state.effects.push({
            label: effectLabel(config, `event:${event}`),
            run: async () => {
              if (typeof sync.ensureReady === 'function') {
                await sync.ensureReady();
              }
              await emit.call(eventBus, event, payload);
            },
          });
        },
      },
    };
  }

  if (mode === 'write-through') {
    const indexDocument = sync.indexDocument;
    const deleteDocument = sync.deleteDocument;
    return {
      ...sync,
      ensureReady: async () => {},
      indexDocument: async (entity: Record<string, unknown>) => {
        if (typeof indexDocument !== 'function') return;
        state.effects.push({
          label: effectLabel(config, 'search:index'),
          run: async () => {
            if (typeof sync.ensureReady === 'function') {
              await sync.ensureReady();
            }
            await indexDocument.call(resolved, entity);
          },
        });
      },
      deleteDocument: async (id: string) => {
        if (typeof deleteDocument !== 'function') return;
        state.effects.push({
          label: effectLabel(config, 'search:delete'),
          run: async () => {
            if (typeof sync.ensureReady === 'function') {
              await sync.ensureReady();
            }
            await deleteDocument.call(resolved, id);
          },
        });
      },
    };
  }

  return resolved;
}

function createEffectBufferingInfra(state: ScopeState): StoreInfra {
  const baseInfra = state.session.storeInfra;
  const scopedInfra = Object.create(baseInfra) as StoreInfra;
  const resolveSearchSync = Reflect.get(baseInfra, RESOLVE_SEARCH_SYNC);
  if (typeof resolveSearchSync === 'function') {
    Object.defineProperty(scopedInfra, RESOLVE_SEARCH_SYNC, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: (config: unknown) =>
        bufferSearchSync(state, config, resolveSearchSync.call(baseInfra, config)),
    });
  }
  return Object.preventExtensions(scopedInfra);
}

function resolveScopedInfra(state: ScopeState): StoreInfra {
  state.scopedInfra ??= createEffectBufferingInfra(state);
  return state.scopedInfra;
}

function trackPromise(state: ScopeState, promiseLike: PromiseLike<unknown>): Promise<unknown> {
  const promise = Promise.resolve(promiseLike);
  state.pending.add(promise);
  void promise.then(
    () => state.pending.delete(promise),
    () => state.pending.delete(promise),
  );
  return promise;
}

function wrapAdapter(state: ScopeState, adapter: object): object {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      let wrappers = state.methodWrappers.get(target);
      if (!wrappers) {
        wrappers = new Map();
        state.methodWrappers.set(target, wrappers);
      }
      const existing = wrappers.get(property);
      if (existing) return existing;

      const wrapped = (...args: unknown[]): unknown => {
        if (state.phase !== 'open') {
          throw new TransactionScopeClosedError(state.scope.id);
        }
        const result = Reflect.apply(value, target, args);
        return isPromiseLike(result) ? trackPromise(state, result) : result;
      };
      wrappers.set(property, wrapped);
      return wrapped;
    },
  });
}

async function settlePending(state: ScopeState): Promise<void> {
  while (state.pending.size > 0) {
    await Promise.allSettled([...state.pending]);
  }
}

async function rollbackPreservingPrimary(
  session: FrameworkTransactionBackendSession,
): Promise<boolean> {
  try {
    await session.rollback();
    return true;
  } catch {
    return false;
  }
}

async function runBufferedEffects(state: ScopeState): Promise<void> {
  const failures: TransactionPostCommitFailure[] = [];
  for (const effect of state.effects) {
    try {
      await effect.run();
    } catch (error) {
      failures.push({
        effect: effect.label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures.length > 0) {
    throw new TransactionPostCommitError(failures);
  }
}

/** Build the one application-owned transaction manager used by route and hook contexts. */
export function createFrameworkTransactionManager(
  providers: readonly FrameworkTransactionBackendProvider[],
): FrameworkTransactionManager {
  const providerByStore = new Map<TransactionStore, FrameworkTransactionBackendProvider>();
  for (const provider of providers) {
    if (providerByStore.has(provider.store)) {
      throw new Error(
        `[slingshot] Multiple transaction providers were registered for '${provider.store}'.`,
      );
    }
    providerByStore.set(provider.store, provider);
  }

  const activeScope = new AsyncLocalStorage<ScopeState>();
  const states = new WeakMap<TransactionScope, ScopeState>();
  const registrations = new Map<string, TransactionEntityAdapterRegistration>();

  const manager: FrameworkTransactionManager = {
    supports(store: StoreType): store is TransactionStore {
      return providerByStore.has(store as TransactionStore);
    },

    async run<T>(
      store: TransactionStore,
      callback: (scope: TransactionScope) => T | Promise<T>,
    ): Promise<T> {
      const active = activeScope.getStore();
      if (active) {
        if (active.phase !== 'open') {
          throw new TransactionScopeClosedError(active.scope.id);
        }
        if (active.scope.store !== store) {
          throw new TransactionScopeMismatchError(active.scope.store, store);
        }
        return callback(active.scope);
      }

      const provider = providerByStore.get(store);
      if (!provider) {
        throw new TransactionStoreUnsupportedError(store);
      }

      const session = await provider.open();
      const scope = Object.freeze({ store, id: scopeId() }) as unknown as TransactionScope;
      const state: ScopeState = {
        scope,
        session,
        pending: new Set(),
        implicitPending: new Set(),
        effects: [],
        adapters: new Map(),
        methodWrappers: new WeakMap(),
        phase: 'open',
        hasImplicitFailure: false,
      };
      states.set(scope, state);

      let result: T | undefined;
      let primaryError: unknown;
      let hasPrimaryError = false;
      try {
        try {
          result = await activeScope.run(state, () => callback(scope));
        } catch (error) {
          primaryError = error;
          hasPrimaryError = true;
        }

        const unsettledCount = [...state.pending].filter(
          promise => !state.implicitPending.has(promise),
        ).length;
        state.phase = 'settling';
        await settlePending(state);

        if (hasPrimaryError) {
          await rollbackPreservingPrimary(session);
          state.phase = 'closed';
          throw primaryError;
        }

        if (unsettledCount > 0) {
          await rollbackPreservingPrimary(session);
          state.phase = 'closed';
          throw new UnsettledTransactionWorkError(scope.id, unsettledCount);
        }

        if (state.hasImplicitFailure) {
          await rollbackPreservingPrimary(session);
          state.phase = 'closed';
          throw state.implicitFailure;
        }

        const rollbackOnly = session.rollbackOnlyCause?.() ?? null;
        if (rollbackOnly) {
          await rollbackPreservingPrimary(session);
          state.phase = 'closed';
          throw rollbackOnly.cause;
        }

        state.phase = 'committing';
        try {
          await session.commit();
        } catch (error) {
          const rolledBack = await rollbackPreservingPrimary(session);
          state.phase = 'closed';
          throw new TransactionCommitError(
            rolledBack ? 'rolled_back' : 'unknown',
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        state.phase = 'closed';
        await runBufferedEffects(state);
      } catch (error) {
        primaryError = error;
        hasPrimaryError = true;
      }

      try {
        await session.release();
      } catch (releaseError) {
        if (!hasPrimaryError) {
          primaryError = releaseError;
          hasPrimaryError = true;
        }
      }

      if (hasPrimaryError) throw primaryError;
      return result as T;
    },

    registerEntity(registration: TransactionEntityAdapterRegistration): void {
      const key = `${registration.plugin}\u0000${registration.entity}`;
      const existing = registrations.get(key);
      if (existing) {
        if (existing.store !== registration.store) {
          throw new Error(
            `[slingshot] Transaction entity '${registration.plugin}/${registration.entity}' was registered for both '${existing.store}' and '${registration.store}'.`,
          );
        }
        return;
      }
      registrations.set(key, Object.freeze({ ...registration }));
    },

    resolveEntity(lookup: TransactionEntityAdapterLookup): object {
      const state = states.get(lookup.scope);
      if (!state) {
        throw new TransactionScopeInvalidError();
      }
      if (state.phase !== 'open') {
        throw new TransactionScopeClosedError(lookup.scope.id);
      }

      const key = `${lookup.plugin}\u0000${lookup.entity}`;
      const registration = registrations.get(key);
      if (!registration) {
        throw new Error(
          `[slingshot] Entity adapter '${lookup.entity}' from plugin '${lookup.plugin}' has no transaction binding metadata.`,
        );
      }
      if (registration.store !== lookup.scope.store) {
        throw new TransactionScopeMismatchError(lookup.scope.store, registration.store);
      }

      const cached = state.adapters.get(key);
      if (cached) return cached;

      const scopedInfra = resolveScopedInfra(state);
      // The provider owns the transaction-bound infra. Entity construction happens
      // only after scope ownership and store compatibility have been validated.
      const adapter = registration.buildAdapter(scopedInfra);
      const wrapped = wrapAdapter(state, adapter);
      state.adapters.set(key, wrapped);
      return wrapped;
    },
  };

  Object.defineProperty(manager, RESOLVE_TRANSACTION_ENTITY_ADAPTER, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: manager.resolveEntity.bind(manager),
  });
  Object.defineProperty(manager, RESOLVE_TRANSACTION_SCOPE_INFRA, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (scope: TransactionScope): StoreInfra => {
      const state = states.get(scope);
      if (!state) {
        throw new TransactionScopeInvalidError();
      }
      if (state.phase !== 'open') {
        throw new TransactionScopeClosedError(scope.id);
      }
      return resolveScopedInfra(state);
    },
  });
  Object.defineProperty(manager, ENQUEUE_TRANSACTION_SCOPE_WORK, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (scope: TransactionScope, work: (infra: StoreInfra) => void | Promise<void>): void => {
      const state = states.get(scope);
      if (!state) {
        throw new TransactionScopeInvalidError();
      }
      if (state.phase !== 'open') {
        throw new TransactionScopeClosedError(scope.id);
      }
      const result = work(resolveScopedInfra(state));
      if (isPromiseLike(result)) {
        const promise = trackPromise(state, result);
        state.implicitPending.add(promise);
        void promise.then(
          () => state.implicitPending.delete(promise),
          error => {
            state.implicitPending.delete(promise);
            if (!state.hasImplicitFailure) {
              state.hasImplicitFailure = true;
              state.implicitFailure = error;
            }
          },
        );
      }
    },
  });

  return Object.freeze(manager);
}
