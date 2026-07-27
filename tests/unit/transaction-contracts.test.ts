import { describe, expect, test } from 'bun:test';
import {
  EntityTransactionConflictError,
  TransactionBindingError,
  TransactionCommitError,
  TransactionPostCommitError,
  TransactionScopeClosedError,
  TransactionScopeMismatchError,
  TransactionStoreUnsupportedError,
  UnsettledTransactionWorkError,
  isHttpError,
} from '@lastshotlabs/slingshot-core';
import type { TransactionStep, TransactionStore } from '@lastshotlabs/slingshot-core';

describe('transaction public errors', () => {
  test('keeps unsupported stores and unnamed semantic steps out of the static contract', () => {
    const store: TransactionStore = 'postgres';
    const step: TransactionStep = {
      op: 'transition',
      entity: 'orders',
      operation: 'confirm',
      match: { id: 'param:id' },
      field: 'status',
      from: 'pending',
      to: 'confirmed',
    };

    const reservedStore: TransactionStore = 'mongo';
    // @ts-expect-error Redis is deliberately outside the real transaction contract.
    const unsupportedStore: TransactionStore = 'redis';
    // @ts-expect-error Semantic steps must identify the configured native operation.
    const unnamedStep: TransactionStep = {
      op: 'transition',
      entity: 'orders',
      match: { id: 'param:id' },
      field: 'status',
      from: 'pending',
      to: 'confirmed',
    };

    expect(store).toBe('postgres');
    expect(step.operation).toBe('confirm');
    expect(reservedStore).toBe('mongo');
    expect(String(unsupportedStore)).toBe('redis');
    expect(unnamedStep.op).toBe('transition');
  });

  test('exposes stable scope and lifecycle error metadata', () => {
    expect(new TransactionStoreUnsupportedError('redis')).toMatchObject({
      name: 'TransactionStoreUnsupportedError',
      code: 'TRANSACTION_STORE_UNSUPPORTED',
      store: 'redis',
    });
    expect(new TransactionScopeMismatchError('postgres', 'sqlite')).toMatchObject({
      code: 'TRANSACTION_SCOPE_MISMATCH',
      activeStore: 'postgres',
      requestedStore: 'sqlite',
    });
    expect(new TransactionScopeClosedError('scope-1')).toMatchObject({
      code: 'TRANSACTION_SCOPE_CLOSED',
      scopeId: 'scope-1',
    });
    expect(new UnsettledTransactionWorkError('scope-1', 2)).toMatchObject({
      code: 'TRANSACTION_WORK_UNSETTLED',
      pendingCount: 2,
    });
  });

  test('uses HTTP-aware binding and conflict errors', () => {
    const binding = new TransactionBindingError('missing param', 'write', 1);
    expect(isHttpError(binding)).toBe(true);
    expect(binding).toMatchObject({
      status: 400,
      code: 'TRANSACTION_BINDING_INVALID',
      operationName: 'write',
      stepIndex: 1,
    });

    const conflict = new EntityTransactionConflictError(
      'transition guard failed',
      'orders',
      'confirm',
      2,
    );
    expect(isHttpError(conflict)).toBe(true);
    expect(conflict).toMatchObject({
      status: 409,
      code: 'ENTITY_TRANSACTION_CONFLICT',
      entity: 'orders',
      operation: 'confirm',
      stepIndex: 2,
    });
  });

  test('distinguishes unknown commit outcomes from post-commit effect failures', () => {
    expect(new TransactionCommitError('unknown')).toMatchObject({
      code: 'TRANSACTION_COMMIT_FAILED',
      outcome: 'unknown',
    });

    const postCommit = new TransactionPostCommitError([
      { effect: 'search:index', message: 'unavailable' },
    ]);
    expect(postCommit).toMatchObject({
      code: 'TRANSACTION_POST_COMMIT_EFFECT_FAILED',
      committed: true,
    });
    expect(postCommit.failures).toEqual([{ effect: 'search:index', message: 'unavailable' }]);
    expect(Object.isFrozen(postCommit.failures)).toBe(true);
    expect(Object.isFrozen(postCommit.failures[0])).toBe(true);
  });
});
