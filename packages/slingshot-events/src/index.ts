/** Public configuration schemas and topology validation. */
export {
  eventInboxConfigSchema,
  eventOutboxConfigSchema,
  eventReliabilityConfigSchema,
  eventReliabilityReadinessConfigSchema,
  eventRetryConfigSchema,
  validateEventReliabilityTopology,
} from './config.schema';
export type { EventReliabilityTopologyInput } from './config.schema';
/** Public transactional event error taxonomy. */
export {
  EventReliabilityTopologyError,
  TransactionalEventDeliveryUnavailableError,
  TransactionalEventError,
  TransactionalEventScopeRequiredError,
  TransactionalEventSerializationError,
  TransactionalEventStoreMismatchError,
} from './errors';
/** Public reliability configuration and consumer contracts. */
export type {
  EventInboxConfig,
  EventOutboxConfig,
  EventReliabilityConfig,
  EventReliabilityReadinessConfig,
  EventReliabilityStore,
  EventRetryConfig,
  TransactionalEventConsumerContext,
  TransactionalEventConsumerOptions,
} from './types';
/** Create the framework-bound transactional outbox writer. */
export { createTransactionalEventOutboxWriter } from './outbox/writer';
export type { EnqueueTransactionScopeWork } from './outbox/writer';
/** Apply package-owned SQL migrations before reliability workers start. */
export { initializeEventReliabilityStore } from './migrations/initialize';
