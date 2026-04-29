// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-kafka/testing — Test utilities
// ---------------------------------------------------------------------------

export {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
  type FakeConsumerRecord,
  type FakeCreateTopicsPayload,
  type FakeKafkaState,
  type FakeProducerSendPayload,
} from './testing/fakeKafkaJs';
