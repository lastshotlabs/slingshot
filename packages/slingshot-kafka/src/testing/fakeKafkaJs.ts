export interface FakeProducerSendPayload {
  topic: string;
  compression?: unknown;
  messages: Array<{
    key?: string;
    value?: Uint8Array | Buffer | string | null;
    headers?: Record<string, string>;
  }>;
}

export interface FakeCreateTopicsPayload {
  topics: Array<{
    topic: string;
    numPartitions?: number;
    replicationFactor?: number;
  }>;
}

export interface FakeConsumerRecord {
  groupId: string;
  connectCalls: number;
  disconnectCalls: number;
  subscribeCalls: Array<{ topic: string | RegExp; fromBeginning: boolean }>;
  runCalls: Array<{ autoCommit?: boolean; partitionsConsumedConcurrently?: number }>;
  commitOffsetCalls: number;
  commitOffsetCallArgs: Array<Array<{ topic: string; partition: number; offset: string }>>;
  pauseCalls: Array<Array<{ topic: string; partitions?: number[] }>>;
  resumeCalls: Array<Array<{ topic: string; partitions?: number[] }>>;
  eventListeners: Map<string, Array<(event: unknown) => void>>;
  eachMessage?: (payload: any) => Promise<void>;
  /** Trigger a registered event listener (e.g. REBALANCING) for testing. */
  emitEvent?: (eventName: string, payload?: unknown) => Promise<void>;
}

export interface FakeKafkaState {
  kafkaConfigs: unknown[];
  producerSendAttempts: FakeProducerSendPayload[];
  producerSendCalls: FakeProducerSendPayload[];
  producerSendErrors: unknown[];
  producerConnectErrors: unknown[];
  producerConnectCalls: number;
  producerDisconnectCalls: number;
  adminConnectErrors: unknown[];
  adminConnectCalls: number;
  adminDisconnectCalls: number;
  createTopicsErrors: unknown[];
  createTopicsCalls: FakeCreateTopicsPayload[];
  consumers: FakeConsumerRecord[];
  consumerConnectErrors: unknown[];
  consumerSubscribeErrors: unknown[];
  consumerRunErrors: unknown[];
  /** Errors to throw from the next consumer.commitOffsets() call(s). */
  commitOffsetErrors: unknown[];
  /** Artificial delays (ms) for the next producer.send() call(s). */
  producerSendDelays: number[];
  /** Sticky default delay (ms) applied to every producer.send() call. */
  producerSendStickyDelayMs: number;
  /** Artificial delays (ms) for the next producer.connect() call(s). */
  producerConnectDelays: number[];
}

export const fakeKafkaState: FakeKafkaState = {
  kafkaConfigs: [],
  producerSendAttempts: [],
  producerSendCalls: [],
  producerSendErrors: [],
  producerConnectErrors: [],
  producerConnectCalls: 0,
  producerDisconnectCalls: 0,
  adminConnectErrors: [],
  adminConnectCalls: 0,
  adminDisconnectCalls: 0,
  createTopicsErrors: [],
  createTopicsCalls: [],
  consumers: [],
  consumerConnectErrors: [],
  consumerSubscribeErrors: [],
  consumerRunErrors: [],
  commitOffsetErrors: [],
  producerSendDelays: [],
  producerSendStickyDelayMs: 0,
  producerConnectDelays: [],
};

export function resetFakeKafkaState(): void {
  fakeKafkaState.kafkaConfigs.length = 0;
  fakeKafkaState.producerSendAttempts.length = 0;
  fakeKafkaState.producerSendCalls.length = 0;
  fakeKafkaState.producerSendErrors.length = 0;
  fakeKafkaState.producerConnectErrors.length = 0;
  fakeKafkaState.producerConnectCalls = 0;
  fakeKafkaState.producerDisconnectCalls = 0;
  fakeKafkaState.adminConnectErrors.length = 0;
  fakeKafkaState.adminConnectCalls = 0;
  fakeKafkaState.adminDisconnectCalls = 0;
  fakeKafkaState.createTopicsErrors.length = 0;
  fakeKafkaState.createTopicsCalls.length = 0;
  fakeKafkaState.consumers.length = 0;
  fakeKafkaState.consumerConnectErrors.length = 0;
  fakeKafkaState.consumerSubscribeErrors.length = 0;
  fakeKafkaState.consumerRunErrors.length = 0;
  fakeKafkaState.commitOffsetErrors.length = 0;
  fakeKafkaState.producerSendDelays.length = 0;
  fakeKafkaState.producerSendStickyDelayMs = 0;
  fakeKafkaState.producerConnectDelays.length = 0;
}

export function flushAsyncWork(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createFakeKafkaJsModule(state: FakeKafkaState = fakeKafkaState) {
  class Kafka {
    constructor(config: unknown) {
      state.kafkaConfigs.push(config);
    }

    producer() {
      return {
        connect: async () => {
          const delay = state.producerConnectDelays.shift();
          if (typeof delay === 'number' && delay > 0) {
            await new Promise(r => setTimeout(r, delay));
          }
          const nextError = state.producerConnectErrors.shift();
          if (nextError) {
            throw nextError;
          }
          state.producerConnectCalls += 1;
        },
        disconnect: async () => {
          state.producerDisconnectCalls += 1;
        },
        send: async (payload: FakeProducerSendPayload) => {
          state.producerSendAttempts.push(payload);
          const oneShotDelay = state.producerSendDelays.shift();
          const delay =
            typeof oneShotDelay === 'number' ? oneShotDelay : state.producerSendStickyDelayMs;
          if (delay > 0) {
            await new Promise(r => setTimeout(r, delay));
          }
          const nextError = state.producerSendErrors.shift();
          if (nextError) {
            throw nextError;
          }
          state.producerSendCalls.push(payload);
          return [];
        },
      };
    }

    admin() {
      return {
        connect: async () => {
          const nextError = state.adminConnectErrors.shift();
          if (nextError) {
            throw nextError;
          }
          state.adminConnectCalls += 1;
        },
        disconnect: async () => {
          state.adminDisconnectCalls += 1;
        },
        createTopics: async (payload: FakeCreateTopicsPayload) => {
          const nextError = state.createTopicsErrors.shift();
          if (nextError) {
            throw nextError;
          }
          state.createTopicsCalls.push(payload);
          return true;
        },
      };
    }

    consumer({ groupId }: { groupId: string }) {
      const record: FakeConsumerRecord = {
        groupId,
        connectCalls: 0,
        disconnectCalls: 0,
        subscribeCalls: [],
        runCalls: [],
        commitOffsetCalls: 0,
        commitOffsetCallArgs: [],
        pauseCalls: [],
        resumeCalls: [],
        eventListeners: new Map(),
      };
      state.consumers.push(record);

      const consumerObj = {
        events: {
          HEARTBEAT: 'consumer.heartbeat',
          COMMIT_OFFSETS: 'consumer.commit_offsets',
          GROUP_JOIN: 'consumer.group_join',
          REBALANCING: 'consumer.rebalancing',
          DISCONNECT: 'consumer.disconnect',
          STOP: 'consumer.stop',
          CRASH: 'consumer.crash',
        },
        connect: async () => {
          const nextError = state.consumerConnectErrors.shift();
          if (nextError) {
            throw nextError;
          }
          record.connectCalls += 1;
        },
        disconnect: async () => {
          record.disconnectCalls += 1;
        },
        subscribe: async (payload: { topic: string | RegExp; fromBeginning: boolean }) => {
          const nextError = state.consumerSubscribeErrors.shift();
          if (nextError) {
            throw nextError;
          }
          record.subscribeCalls.push(payload);
        },
        run: async ({
          autoCommit,
          partitionsConsumedConcurrently,
          eachMessage,
        }: {
          autoCommit?: boolean;
          partitionsConsumedConcurrently?: number;
          eachMessage: (payload: any) => Promise<void>;
        }) => {
          const nextError = state.consumerRunErrors.shift();
          if (nextError) {
            throw nextError;
          }
          record.runCalls.push({ autoCommit, partitionsConsumedConcurrently });
          record.eachMessage = eachMessage;
        },
        commitOffsets: async (
          args: Array<{ topic: string; partition: number; offset: string }>,
        ) => {
          record.commitOffsetCalls += 1;
          record.commitOffsetCallArgs.push(args ?? []);
          const nextError = state.commitOffsetErrors.shift();
          if (nextError) throw nextError;
        },
        pause: (args: Array<{ topic: string; partitions?: number[] }>) => {
          record.pauseCalls.push(args ?? []);
        },
        resume: (args: Array<{ topic: string; partitions?: number[] }>) => {
          record.resumeCalls.push(args ?? []);
        },
        on: (eventName: string, listener: (event: unknown) => void) => {
          const list = record.eventListeners.get(eventName) ?? [];
          list.push(listener);
          record.eventListeners.set(eventName, list);
          return () => {
            const current = record.eventListeners.get(eventName);
            if (!current) return;
            record.eventListeners.set(
              eventName,
              current.filter(l => l !== listener),
            );
          };
        },
      };

      record.emitEvent = async (eventName: string, payload?: unknown) => {
        const listeners = record.eventListeners.get(eventName) ?? [];
        for (const listener of listeners) {
          await Promise.resolve(listener(payload));
        }
      };

      return consumerObj;
    }
  }

  return {
    Kafka,
    CompressionTypes: {
      GZIP: 'gzip',
      Snappy: 'snappy',
      LZ4: 'lz4',
      ZSTD: 'zstd',
    },
  };
}
