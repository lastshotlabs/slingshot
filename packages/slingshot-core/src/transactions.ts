import { HttpError, SlingshotError } from './errors';
import type { StoreType } from './storeType';

/** Stores reserved for real framework-owned transaction implementations. */
export type TransactionStore = Extract<StoreType, 'postgres' | 'sqlite' | 'mongo'>;

declare const transactionScopeBrand: unique symbol;

/**
 * Opaque identity for one framework-owned transaction.
 *
 * A scope contains no database driver. Obtain it only from {@link TransactionManager.run}
 * and pass it back through scope-aware framework APIs.
 */
export interface TransactionScope {
  /** Store that owns this transaction. */
  readonly store: TransactionStore;
  /** Opaque correlation identifier for diagnostics. */
  readonly id: string;
  /** @internal Compile-time nominal brand; runtime authenticity uses a private registry. */
  readonly [transactionScopeBrand]: true;
}

/** Bind an entity resolution to one open transaction scope. */
export interface TransactionEntityResolutionOptions {
  readonly scope: TransactionScope;
}

/** Result value produced by one declarative transaction step. */
export type TransactionStepResult = Record<string, unknown> | null;

/** Framework-owned entry point for imperative package/domain transactions. */
export interface TransactionManager {
  /** Return whether this app instance can open a real transaction for `store`. */
  supports(store: StoreType): store is TransactionStore;

  /**
   * Run `callback` inside one real transaction.
   *
   * Same-store nested calls reuse the active scope. Cross-store nesting and unsupported
   * stores reject before a second backend connection is opened. Resolve participating
   * entities with `{ scope }` inside the callback and await every scoped operation.
   * Retained scopes/adapters close when the callback settles; pending work causes rollback.
   *
   * The boundary covers database work only. Arbitrary HTTP, queue, email, and object-storage
   * effects are not made atomic by this API.
   */
  run<T>(
    store: TransactionStore,
    callback: (scope: TransactionScope) => T | Promise<T>,
  ): Promise<T>;
}

/**
 * Create an explicit manager for infrastructure that supports no rollback transactions.
 *
 * Manual repository fixtures can use this helper to satisfy {@link StoreInfra} without
 * accidentally claiming that a configured client provides framework transaction semantics.
 */
export function createUnsupportedTransactionManager(): TransactionManager {
  return Object.freeze({
    supports(_store: StoreType): _store is TransactionStore {
      return false;
    },
    run<T>(store: TransactionStore, _callback: (scope: TransactionScope) => T | Promise<T>) {
      void _callback;
      return Promise.reject(new TransactionStoreUnsupportedError(store));
    },
  });
}

/** Thrown when an app cannot provide a real transaction for the requested store. */
export class TransactionStoreUnsupportedError extends SlingshotError {
  override readonly name = 'TransactionStoreUnsupportedError';

  constructor(readonly store: StoreType) {
    super(
      'TRANSACTION_STORE_UNSUPPORTED',
      `Store '${store}' does not provide a real transaction in this app instance.`,
    );
  }
}

/** Thrown for a forged scope, a foreign-app scope, or a scope owned by another manager. */
export class TransactionScopeInvalidError extends SlingshotError {
  override readonly name = 'TransactionScopeInvalidError';

  constructor(message = 'The transaction scope is not owned by this app instance.') {
    super('TRANSACTION_SCOPE_INVALID', message);
  }
}

/** Thrown when nested or entity work targets a store different from the active scope. */
export class TransactionScopeMismatchError extends SlingshotError {
  override readonly name = 'TransactionScopeMismatchError';

  constructor(
    readonly activeStore: TransactionStore,
    readonly requestedStore: StoreType,
  ) {
    super(
      'TRANSACTION_SCOPE_MISMATCH',
      `Transaction scope for '${activeStore}' cannot be used with '${requestedStore}'.`,
    );
  }
}

/** Thrown when a retained scope or scoped adapter is used after its callback settles. */
export class TransactionScopeClosedError extends SlingshotError {
  override readonly name = 'TransactionScopeClosedError';

  constructor(readonly scopeId: string) {
    super('TRANSACTION_SCOPE_CLOSED', `Transaction scope '${scopeId}' is already closed.`);
  }
}

/** Thrown after rollback when a callback returned with scope-bound work still pending. */
export class UnsettledTransactionWorkError extends SlingshotError {
  override readonly name = 'UnsettledTransactionWorkError';

  constructor(
    readonly scopeId: string,
    readonly pendingCount: number,
  ) {
    super(
      'TRANSACTION_WORK_UNSETTLED',
      `Transaction scope '${scopeId}' callback returned with ${pendingCount} unsettled operation(s).`,
    );
  }
}

/** HTTP 400 error for a missing or malformed declarative transaction binding. */
export class TransactionBindingError extends HttpError {
  override readonly name = 'TransactionBindingError';

  constructor(
    message: string,
    readonly operationName?: string,
    readonly stepIndex?: number,
  ) {
    super(400, message, 'TRANSACTION_BINDING_INVALID');
  }
}

/** HTTP 409 error for a guarded or required transaction mutation that did not apply. */
export class EntityTransactionConflictError extends HttpError {
  override readonly name = 'EntityTransactionConflictError';

  constructor(
    message: string,
    readonly entity: string,
    readonly operation: string,
    readonly stepIndex?: number,
  ) {
    super(409, message, 'ENTITY_TRANSACTION_CONFLICT');
  }
}

/** Outcome that can be stated truthfully after a commit failure. */
export type TransactionCommitFailureOutcome = 'rolled_back' | 'unknown';

/** Thrown when commit fails, including whether rollback can be proven. */
export class TransactionCommitError extends SlingshotError {
  override readonly name = 'TransactionCommitError';

  constructor(
    readonly outcome: TransactionCommitFailureOutcome,
    cause?: Error,
  ) {
    super(
      'TRANSACTION_COMMIT_FAILED',
      `Transaction commit failed; final outcome is '${outcome}'.`,
      cause,
    );
  }
}

/** One sanitized framework-owned effect that failed after database commit. */
export interface TransactionPostCommitFailure {
  readonly effect: string;
  readonly message: string;
}

/** Reports framework-owned post-commit failures without claiming the database rolled back. */
export class TransactionPostCommitError extends SlingshotError {
  override readonly name = 'TransactionPostCommitError';
  readonly committed = true;
  readonly failures: readonly TransactionPostCommitFailure[];

  constructor(failures: readonly TransactionPostCommitFailure[]) {
    super(
      'TRANSACTION_POST_COMMIT_EFFECT_FAILED',
      `Transaction committed, but ${failures.length} post-commit effect(s) failed.`,
    );
    this.failures = Object.freeze(
      failures.map(failure =>
        Object.freeze({
          effect: failure.effect,
          message: failure.message,
        }),
      ),
    );
  }
}
