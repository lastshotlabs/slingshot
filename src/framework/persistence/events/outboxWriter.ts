import type {
  EventEnvelope,
  StoreInfra,
  TransactionScope,
  TransactionalEventOutboxWriter,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventDeliveryUnavailableError,
  createTransactionalEventOutboxWriter,
} from '@lastshotlabs/slingshot-events';
import type { EventReliabilityConfig } from '@lastshotlabs/slingshot-events';
import { ENQUEUE_TRANSACTION_SCOPE_WORK } from '../transactions/frameworkTransactionManager';

/** Root-owned bridge bound after framework transaction infrastructure is created. */
export interface FrameworkEventOutboxWriter extends TransactionalEventOutboxWriter {
  /** Bind the one application-owned scope resolver exactly once. */
  bind(infra: StoreInfra): void;
}

/** Create an outbox writer bridge without opening infrastructure. */
export function createFrameworkEventOutboxWriter(
  config: EventReliabilityConfig | undefined,
): FrameworkEventOutboxWriter {
  let delegate: TransactionalEventOutboxWriter | null = null;
  let bound = false;

  return Object.freeze({
    bind(infra: StoreInfra): void {
      if (bound) {
        throw new Error('[slingshot] Transactional event outbox writer is already bound.');
      }
      bound = true;
      if (!config?.outbox) return;
      const transactions = infra.getTransactions();
      const enqueue = Reflect.get(transactions, ENQUEUE_TRANSACTION_SCOPE_WORK);
      if (typeof enqueue !== 'function') {
        throw new TransactionalEventDeliveryUnavailableError(
          'The application transaction manager cannot bind transactional event work.',
        );
      }
      delegate = createTransactionalEventOutboxWriter(config.store, (scope, work) => {
        enqueue.call(transactions, scope, work);
      });
    },

    write(envelope: EventEnvelope, scope?: TransactionScope): void {
      if (!delegate) {
        throw new TransactionalEventDeliveryUnavailableError();
      }
      delegate.write(envelope, scope);
    },
  });
}
