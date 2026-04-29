/** Create the Kafka-backed Slingshot event bus adapter and expose its config schema. */
export {
  createKafkaAdapter,
  kafkaAdapterOptionsSchema,
  getKafkaAdapterIntrospectionOrNull,
} from './kafkaAdapter';
/** Public types returned by the Kafka event bus adapter. */
export type {
  KafkaAdapterDeserErrorPolicy,
  KafkaAdapterDropEvent,
  KafkaAdapterDropReason,
  KafkaAdapterHealth,
  KafkaAdapterHealthSnapshot,
  KafkaAdapterIntrospection,
  KafkaAdapterOptions,
} from './kafkaAdapter';
/** Create the programmatic Kafka connector bridge and expose its config schema. */
export {
  createInMemoryDedupStore,
  createKafkaConnectors,
  kafkaConnectorsSchema,
} from './kafkaConnectors';
/** Public config types for the Kafka connector bridge. */
export type {
  ConnectorObservabilityHooks,
  DuplicatePublishPolicy,
  InboundConnectorConfig,
  KafkaConnectorsConfig,
  MessageDedupStore,
  OutboundConnectorConfig,
} from './kafkaConnectors';
/** Convert Slingshot event names into stable Kafka topic and consumer-group names. */
export { toGroupId, toTopicName } from './kafkaTopicNaming';
/** Typed error classes thrown by the Kafka adapter and connector bridge. */
export {
  KafkaAdapterError,
  KafkaAdapterConfigError,
  KafkaDurableSubscriptionNameRequiredError,
  KafkaDuplicateDurableSubscriptionError,
  KafkaDurableSubscriptionOffError,
  KafkaConnectorError,
  KafkaConnectorMessageIdError,
  KafkaConnectorStateError,
  KafkaConnectorValidationError,
  KafkaDuplicateConnectorError,
} from './errors';
