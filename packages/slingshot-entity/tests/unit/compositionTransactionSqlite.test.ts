import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { EntityAdapter, StoreInfra } from '@lastshotlabs/slingshot-core';
import {
  EntityTransactionConflictError,
  createUnsupportedTransactionManager,
} from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, defineEntity, field, op } from '../../src/index';

const RecordEntity = defineEntity('TransactionRecord', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true }),
    status: field.enum(['pending', 'done'] as const),
    count: field.integer(),
    value: field.string(),
  },
});

const RecordOperations = {
  setValue: op.fieldUpdate({ match: { id: 'param:id' }, set: ['value'] }),
  advance: op.transition({
    field: 'status',
    from: 'pending',
    to: 'done',
    match: { id: 'param:id' },
  }),
  purgePending: op.batch({ action: 'delete', filter: { status: 'param:status' } }),
  addCount: op.increment({ field: 'count' }),
};

const rollbackStep = {
  op: 'update',
  entity: 'records',
  match: { id: 'param:missingId' },
  set: { value: 'unreachable' },
} as const;

const factories = createCompositeFactories(
  { records: { config: RecordEntity, operations: RecordOperations } },
  {
    fieldUpdateThenFail: op.transaction({
      steps: [
        {
          op: 'fieldUpdate',
          entity: 'records',
          operation: 'setValue',
          input: { id: 'param:id', value: 'param:value' },
        },
        rollbackStep,
      ],
    }),
    transitionThenFail: op.transaction({
      steps: [
        {
          op: 'transition',
          entity: 'records',
          operation: 'advance',
          input: { id: 'param:id' },
        },
        rollbackStep,
      ],
    }),
    batchThenFail: op.transaction({
      steps: [
        {
          op: 'batch',
          entity: 'records',
          operation: 'purgePending',
          input: { status: 'param:status' },
        },
        rollbackStep,
      ],
    }),
    incrementThenFail: op.transaction({
      steps: [
        {
          op: 'increment',
          entity: 'records',
          operation: 'addCount',
          input: { id: 'param:id', by: 4 },
        },
        rollbackStep,
      ],
    }),
  },
);

interface Composite {
  readonly records: EntityAdapter<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >;
  fieldUpdateThenFail(params: Record<string, unknown>): Promise<unknown>;
  transitionThenFail(params: Record<string, unknown>): Promise<unknown>;
  batchThenFail(params: Record<string, unknown>): Promise<unknown>;
  incrementThenFail(params: Record<string, unknown>): Promise<unknown>;
}

function sqliteInfra(db: Database): StoreInfra {
  return {
    appName: 'transaction-test',
    getTransactions: () => createUnsupportedTransactionManager(),
    getSqliteDb: () => db,
    getPostgres: () => {
      throw new Error('PostgreSQL not configured');
    },
    getMongo: () => {
      throw new Error('MongoDB not configured');
    },
    getRedis: () => {
      throw new Error('Redis not configured');
    },
  };
}

const cases = [
  {
    name: 'field update',
    method: 'fieldUpdateThenFail',
    params: { id: 'r1', value: 'changed', missingId: 'missing' },
  },
  {
    name: 'transition',
    method: 'transitionThenFail',
    params: { id: 'r1', missingId: 'missing' },
  },
  {
    name: 'batch',
    method: 'batchThenFail',
    params: { status: 'pending', missingId: 'missing' },
  },
  {
    name: 'increment',
    method: 'incrementThenFail',
    params: { id: 'r1', missingId: 'missing' },
  },
] as const;

describe('SQLite composite native transaction steps', () => {
  for (const scenario of cases) {
    test(`${scenario.name} uses the named method and rolls back on a later conflict`, async () => {
      const db = new Database(':memory:');
      try {
        const composite = factories.sqlite(sqliteInfra(db)) as unknown as Composite;
        await composite.records.create({
          id: 'r1',
          status: 'pending',
          count: 1,
          value: 'original',
        });

        await expect(composite[scenario.method](scenario.params)).rejects.toBeInstanceOf(
          EntityTransactionConflictError,
        );

        expect(await composite.records.getById('r1')).toMatchObject({
          id: 'r1',
          status: 'pending',
          count: 1,
          value: 'original',
        });
      } finally {
        db.close();
      }
    });
  }
});
