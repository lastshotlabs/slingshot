import type {
  EventEnvelope,
  EventKey,
  SlingshotEventBus,
  StoreInfra,
  TransactionManager,
  TransactionScope,
  TransactionalEventConsumer,
  TransactionalEventConsumerContext,
  TransactionalEventConsumerOptions,
  TransactionalEventUnsubscribe,
} from '@lastshotlabs/slingshot-core';
import {
  TransactionalEventDeliveryUnavailableError,
  TransactionalEventStoreMismatchError,
} from './errors';
import { createPostgresInboxRepository } from './inbox/postgres';
import type { NewInboxReceipt } from './inbox/repository';
import { createSqliteInboxRepository } from './inbox/sqlite';
import type { EventReliabilityStore } from './types';

/** Resolve the transaction-bound infrastructure view for one authentic open scope. */
export type ResolveTransactionScopeInfra = (scope: TransactionScope) => StoreInfra;

/** Bounded-cardinality inbox signal for framework metrics. */
export interface InboxLifecycleEvent {
  readonly action: 'duplicate' | 'handler_failure';
}

/** Build the governed durable consumer wrapper used by `events.consume()`. */
export function createTransactionalEventConsumer(
  configuredStore: EventReliabilityStore,
  bus: SlingshotEventBus,
  transactions: TransactionManager,
  resolveInfra: ResolveTransactionScopeInfra,
  onLifecycle?: (event: InboxLifecycleEvent) => void,
): TransactionalEventConsumer {
  return Object.freeze({
    consume<K extends EventKey>(
      key: K,
      handler: (
        envelope: EventEnvelope<K>,
        context: TransactionalEventConsumerContext,
      ) => void | Promise<void>,
      options: TransactionalEventConsumerOptions,
    ): TransactionalEventUnsubscribe {
      if (options.inbox.store !== configuredStore) {
        throw new TransactionalEventStoreMismatchError(configuredStore, options.inbox.store);
      }
      if (!transactions.supports(configuredStore)) {
        throw new TransactionalEventDeliveryUnavailableError(
          `Transactional inbox store '${configuredStore}' is unavailable.`,
        );
      }

      const listener = async (envelope: EventEnvelope<K>): Promise<void> => {
        await transactions.run(configuredStore, async scope => {
          const infra = resolveInfra(scope);
          const repository =
            configuredStore === 'postgres'
              ? createPostgresInboxRepository(infra.getPostgres())
              : createSqliteInboxRepository(infra.getSqliteDb());
          const receipt: NewInboxReceipt = {
            consumerName: options.name,
            eventId: envelope.meta.eventId,
            eventKey: envelope.key,
            processedAt: new Date().toISOString(),
            occurredAt: envelope.meta.occurredAt,
          };
          if (!(await repository.insert(receipt))) {
            onLifecycle?.({ action: 'duplicate' });
            return;
          }
          try {
            await handler(envelope, {
              scope,
              eventId: envelope.meta.eventId,
              consumerName: options.name,
            });
          } catch (error) {
            onLifecycle?.({ action: 'handler_failure' });
            throw error;
          }
        });
      };
      bus.onEnvelope(key, listener, { durable: true, name: options.name });

      let subscribed = true;
      return (): boolean => {
        if (!subscribed) return false;
        try {
          const removed = bus.offEnvelope(key, listener);
          subscribed = !removed;
          return removed;
        } catch {
          // Durable production subscriptions are owned by bus shutdown.
          subscribed = false;
          return false;
        }
      };
    },
  });
}
