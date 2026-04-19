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
  eachMessage?: (payload: any) => Promise<void>;
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
  createTopicsCalls: FakeCreateTopicsPayload[];
  consumers: FakeConsumerRecord[];
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
  createTopicsCalls: [],
  consumers: [],
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
  fakeKafkaState.createTopicsCalls.length = 0;
  fakeKafkaState.consumers.length = 0;
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
      };
      state.consumers.push(record);

      return {
        connect: async () => {
          record.connectCalls += 1;
        },
        disconnect: async () => {
          record.disconnectCalls += 1;
        },
        subscribe: async (payload: { topic: string | RegExp; fromBeginning: boolean }) => {
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
          record.runCalls.push({ autoCommit, partitionsConsumedConcurrently });
          record.eachMessage = eachMessage;
        },
        commitOffsets: async () => {},
      };
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
