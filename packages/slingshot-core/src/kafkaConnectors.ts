import type { SlingshotEventBus } from './eventBus';

/**
 * Health snapshot for one inbound Kafka connector.
 */
export interface KafkaInboundConnectorHealth {
  /** Consumed topic or topic-pattern label. */
  readonly topic: string;
  /** Kafka consumer group assigned to the connector. */
  readonly groupId: string;
  /** Current runtime state of the connector. */
  readonly status: 'connecting' | 'active' | 'paused' | 'stopped' | 'error';
  /** Number of inbound messages handled successfully. */
  readonly messagesProcessed: number;
  /** Number of inbound messages diverted to a dead-letter topic. */
  readonly messagesDLQ: number;
  /** Last runtime error, when the connector is paused or degraded. */
  readonly error?: string;
}

/**
 * Health snapshot for one outbound Kafka connector.
 */
export interface KafkaOutboundConnectorHealth {
  /** Slingshot event key that feeds the connector. */
  readonly event: string;
  /** Kafka topic targeted by the connector. */
  readonly topic: string;
  /** Current runtime state of the connector. */
  readonly status: 'active' | 'stopped' | 'error';
  /** Number of messages published successfully. */
  readonly messagesProduced: number;
  /** Number of buffered outbound messages waiting to be retried. */
  readonly pendingCount: number;
  /** Last runtime error, when the connector is degraded. */
  readonly error?: string;
}

/**
 * Aggregate health for the Kafka connector bridge.
 */
export interface KafkaConnectorHealth {
  /** Whether the bridge has been started successfully. */
  readonly started: boolean;
  /** Health snapshots for inbound connectors. */
  readonly inbound: readonly KafkaInboundConnectorHealth[];
  /** Health snapshots for outbound connectors. */
  readonly outbound: readonly KafkaOutboundConnectorHealth[];
  /** Total outbound messages buffered for retry. */
  readonly pendingBufferSize: number;
}

/**
 * Programmatic lifecycle contract for Kafka connectors that bridge the
 * internal bus to external Kafka topics.
 */
export interface KafkaConnectorHandle {
  /** Stable package-owned connector name. */
  readonly name: 'slingshot-kafka-connectors';
  /** Start the bridge and bind it to a Slingshot event bus. */
  start(bus: SlingshotEventBus): Promise<void>;
  /** Stop the bridge and disconnect all Kafka clients. */
  stop(): Promise<void>;
  /** Read current inbound, outbound, and buffer health. */
  health(): KafkaConnectorHealth;
  /** Read only the current retry-buffer size. */
  pendingBufferSize(): number;
}
