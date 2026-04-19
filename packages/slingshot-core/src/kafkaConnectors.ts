import type { SlingshotEventBus } from './eventBus';

/**
 * Health snapshot for one inbound Kafka connector.
 */
export interface KafkaInboundConnectorHealth {
  readonly topic: string;
  readonly groupId: string;
  readonly status: 'connecting' | 'active' | 'paused' | 'stopped' | 'error';
  readonly messagesProcessed: number;
  readonly messagesDLQ: number;
  readonly error?: string;
}

/**
 * Health snapshot for one outbound Kafka connector.
 */
export interface KafkaOutboundConnectorHealth {
  readonly event: string;
  readonly topic: string;
  readonly status: 'active' | 'stopped' | 'error';
  readonly messagesProduced: number;
  readonly pendingCount: number;
  readonly error?: string;
}

/**
 * Aggregate health for the Kafka connector bridge.
 */
export interface KafkaConnectorHealth {
  readonly started: boolean;
  readonly inbound: readonly KafkaInboundConnectorHealth[];
  readonly outbound: readonly KafkaOutboundConnectorHealth[];
  readonly pendingBufferSize: number;
}

/**
 * Programmatic lifecycle contract for Kafka connectors that bridge the
 * internal bus to external Kafka topics.
 */
export interface KafkaConnectorHandle {
  readonly name: 'slingshot-kafka-connectors';
  start(bus: SlingshotEventBus): Promise<void>;
  stop(): Promise<void>;
  health(): KafkaConnectorHealth;
  pendingBufferSize(): number;
}
