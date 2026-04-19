import { z } from 'zod';

const kafkaSaslSchema = z.discriminatedUnion('mechanism', [
  z
    .object({
      mechanism: z.literal('plain'),
      username: z.string().describe('Kafka SASL username.'),
      password: z.string().describe('Kafka SASL password.'),
    })
    .strict(),
  z
    .object({
      mechanism: z.literal('scram-sha-256'),
      username: z.string().describe('Kafka SASL username.'),
      password: z.string().describe('Kafka SASL password.'),
    })
    .strict(),
  z
    .object({
      mechanism: z.literal('scram-sha-512'),
      username: z.string().describe('Kafka SASL username.'),
      password: z.string().describe('Kafka SASL password.'),
    })
    .strict(),
]);

const kafkaSslSchema = z.union([
  z.literal(true),
  z
    .object({
      ca: z.string().optional().describe('PEM-encoded CA certificate.'),
      cert: z.string().optional().describe('PEM-encoded client certificate.'),
      key: z.string().optional().describe('PEM-encoded client private key.'),
      rejectUnauthorized: z
        .boolean()
        .optional()
        .describe('Whether to reject invalid broker certificates.'),
    })
    .strict(),
]);

const kafkaCompressionSchema = z.enum(['gzip', 'snappy', 'lz4', 'zstd']);
const validationModeSchema = z.enum(['strict', 'warn', 'off']);

const manifestKafkaInboundConnectorSchema = z
  .object({
    topic: z
      .string()
      .optional()
      .describe('External Kafka topic. Mutually exclusive with topicPattern.'),
    topicPattern: z
      .string()
      .optional()
      .describe('Regex string for topic subscription. Mutually exclusive with topic.'),
    handler: z.string().describe('Named handler exported from the manifest handler registry.'),
    groupId: z.string().describe('Kafka consumer group ID for this connector.'),
    fromBeginning: z.boolean().optional().describe('Consume from earliest available offset.'),
    maxRetries: z.number().int().min(0).optional().describe('Maximum in-process retry attempts.'),
    sessionTimeout: z
      .number()
      .int()
      .min(6000)
      .optional()
      .describe('Kafka session timeout in milliseconds.'),
    heartbeatInterval: z
      .number()
      .int()
      .min(1000)
      .optional()
      .describe('Kafka heartbeat interval in milliseconds.'),
    concurrency: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum concurrent message processing per partition.'),
    validationMode: validationModeSchema
      .optional()
      .describe('Inbound event validation mode for this connector.'),
    errorStrategy: z
      .enum(['dlq', 'skip', 'pause'])
      .optional()
      .describe('Strategy applied after retries are exhausted.'),
    dlqTopic: z.string().optional().describe('Explicit dead-letter topic name.'),
    autoCreateDLQ: z.boolean().optional().describe('Auto-create the DLQ topic on first use.'),
  })
  .strict();

const manifestKafkaOutboundConnectorSchema = z
  .object({
    event: z.string().describe('Internal Slingshot event key to forward.'),
    topic: z.string().describe('External Kafka topic to produce to.'),
    partitionKey: z
      .string()
      .optional()
      .describe('Payload field name used to derive the Kafka partition key.'),
    messageId: z
      .string()
      .optional()
      .describe('Payload field name used to populate slingshot.message-id.'),
    validationMode: validationModeSchema
      .optional()
      .describe('Outbound event validation mode for this connector.'),
    autoCreateTopic: z.boolean().optional().describe('Auto-create the topic on first use.'),
    partitions: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Topic partition count when auto-creating.'),
    replicationFactor: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Topic replication factor when auto-creating.'),
    compression: kafkaCompressionSchema
      .optional()
      .describe('Compression codec override for this connector.'),
    durable: z
      .boolean()
      .optional()
      .describe('Register as a durable internal bus subscriber before forwarding to Kafka.'),
    name: z.string().optional().describe('Durable subscriber name when durable is enabled.'),
  })
  .strict();

export const manifestKafkaConnectorsSchema = z
  .object({
    brokers: z
      .array(z.string())
      .optional()
      .describe('Kafka broker addresses. Omit to resolve from KAFKA_BROKERS.'),
    clientId: z.string().optional().describe('Kafka client identifier.'),
    sasl: kafkaSaslSchema.optional().describe('Kafka SASL authentication configuration.'),
    ssl: kafkaSslSchema.optional().describe('Kafka TLS configuration.'),
    validationMode: validationModeSchema
      .optional()
      .describe('Default validation mode applied when schemas are available.'),
    compression: kafkaCompressionSchema
      .optional()
      .describe('Default compression codec for outbound connectors.'),
    inbound: z
      .array(manifestKafkaInboundConnectorSchema)
      .optional()
      .describe('Inbound connectors that consume external Kafka topics.'),
    outbound: z
      .array(manifestKafkaOutboundConnectorSchema)
      .optional()
      .describe('Outbound connectors that forward internal events to Kafka.'),
  })
  .strict();
