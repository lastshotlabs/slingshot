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
/** Lease-based acknowledged outbox dispatcher and store adapters. */
export { createOutboxDispatcher } from './outbox/dispatcher';
export type { OutboxDispatcher, OutboxDispatcherOptions } from './outbox/dispatcher';
export {
  createPostgresOutboxDispatchRepository,
  createPostgresOutboxRepository,
} from './outbox/postgres';
export {
  createSqliteOutboxDispatchRepository,
  createSqliteOutboxRepository,
} from './outbox/sqlite';
export type {
  LeasedOutboxRow,
  NewOutboxRow,
  OutboxDispatchRepository,
  OutboxRepository,
} from './outbox/repository';
export { serializeOutboxEnvelope } from './outbox/repository';
/** Governed transactionally deduplicated consumer implementation. */
export { createTransactionalEventConsumer } from './consume';
export type { ResolveTransactionScopeInfra } from './consume';
/** Transaction-bound inbox repository implementations. */
export { createPostgresInboxRepository } from './inbox/postgres';
export { createSqliteInboxRepository } from './inbox/sqlite';
export type { InboxRepository, NewInboxReceipt } from './inbox/repository';
/** Apply package-owned SQL migrations before reliability workers start. */
export { initializeEventReliabilityStore } from './migrations/initialize';
