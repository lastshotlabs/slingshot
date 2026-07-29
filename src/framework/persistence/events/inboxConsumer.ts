import type {
  EventEnvelope,
  EventKey,
  SlingshotEventBus,
  StoreInfra,
  TransactionalEventConsumer,
  TransactionalEventConsumerContext,
  TransactionalEventConsumerOptions,
  TransactionalEventUnsubscribe,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventDeliveryUnavailableError,
  createTransactionalEventConsumer,
} from '@lastshotlabs/slingshot-events';
import type { EventReliabilityConfig } from '@lastshotlabs/slingshot-events';

const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');

/** Root-owned inbox bridge bound after transaction infrastructure is created. */
export interface FrameworkEventInboxConsumer extends TransactionalEventConsumer {
  bind(infra: StoreInfra): void;
}

/** Create an inbox consumer bridge without opening infrastructure. */
export function createFrameworkEventInboxConsumer(
  config: EventReliabilityConfig | undefined,
  bus: SlingshotEventBus,
): FrameworkEventInboxConsumer {
  let delegate: TransactionalEventConsumer | null = null;
  let bound = false;
  return Object.freeze({
    bind(infra: StoreInfra): void {
      if (bound) throw new Error('[slingshot] Transactional event inbox is already bound.');
      bound = true;
      if (!config?.inbox) return;
      const transactions = infra.getTransactions();
      const resolveInfra = Reflect.get(transactions, RESOLVE_TRANSACTION_SCOPE_INFRA);
      if (typeof resolveInfra !== 'function') {
        throw new TransactionalEventDeliveryUnavailableError(
          'The application transaction manager cannot bind transactional inbox work.',
        );
      }
      delegate = createTransactionalEventConsumer(config.store, bus, transactions, scope =>
        resolveInfra.call(transactions, scope),
      );
    },

    consume<K extends EventKey>(
      key: K,
      handler: (
        envelope: EventEnvelope<K>,
        context: TransactionalEventConsumerContext,
      ) => void | Promise<void>,
      options: TransactionalEventConsumerOptions,
    ): TransactionalEventUnsubscribe {
      if (!delegate) throw new TransactionalEventDeliveryUnavailableError();
      return delegate.consume(key, handler, options);
    },
  });
}
