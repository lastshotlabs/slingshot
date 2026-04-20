/** Create the Kafka-backed Slingshot event bus adapter and expose its config schema. */
export {
  createKafkaAdapter,
  kafkaAdapterOptionsSchema,
  getKafkaAdapterIntrospectionOrNull,
} from './kafkaAdapter';
/** Public types returned by the Kafka event bus adapter. */
export type {
  KafkaAdapterHealth,
  KafkaAdapterIntrospection,
  KafkaAdapterOptions,
} from './kafkaAdapter';
/** Create the programmatic Kafka connector bridge and expose its config schema. */
export { createKafkaConnectors, kafkaConnectorsSchema } from './kafkaConnectors';
/** Public config types for the Kafka connector bridge. */
export type {
  DuplicatePublishPolicy,
  InboundConnectorConfig,
  KafkaConnectorsConfig,
  OutboundConnectorConfig,
} from './kafkaConnectors';
/** Convert Slingshot event names into stable Kafka topic and consumer-group names. */
export { toGroupId, toTopicName } from './kafkaTopicNaming';
