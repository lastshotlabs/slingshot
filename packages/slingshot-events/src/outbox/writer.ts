import type {
  EventEnvelope,
  StoreInfra,
  TransactionScope,
  TransactionalEventOutboxWriter,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventScopeRequiredError,
  TransactionalEventSerializationError,
  TransactionalEventStoreMismatchError,
} from '../errors';
import type { EventReliabilityStore } from '../types';
import { createPostgresOutboxRepository } from './postgres';
import { serializeOutboxEnvelope } from './repository';
import { createSqliteOutboxRepository } from './sqlite';

/** Internal scope-work scheduler supplied by the framework transaction manager. */
export type EnqueueTransactionScopeWork = (
  scope: TransactionScope,
  work: (infra: StoreInfra) => void | Promise<void>,
) => void;

/** Build the transaction-bound writer used by the governed event publisher. */
export function createTransactionalEventOutboxWriter(
  store: EventReliabilityStore,
  enqueue: EnqueueTransactionScopeWork,
): TransactionalEventOutboxWriter {
  return Object.freeze({
    write(envelope: EventEnvelope, scope?: TransactionScope): void {
      if (!scope) {
        throw new TransactionalEventScopeRequiredError();
      }
      if (scope.store !== store) {
        throw new TransactionalEventStoreMismatchError(store, scope.store);
      }

      let row;
      try {
        row = serializeOutboxEnvelope(envelope);
      } catch (error) {
        throw new TransactionalEventSerializationError(
          'Governed event envelope could not be serialized for outbox persistence.',
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      enqueue(scope, infra => {
        const repository =
          store === 'postgres'
            ? createPostgresOutboxRepository(infra.getPostgres())
            : createSqliteOutboxRepository(infra.getSqliteDb());
        return repository.insert(row);
      });
    },
  });
}
