/**
 * Unified metrics emitter integration tests for slingshot-kafka.
 *
 * Wires an in-process MetricsEmitter into the Kafka adapter and asserts that
 * publish/consume counters, durations, and connection-state gauges land in
 * the snapshot after a representative workload (publish, consume, DLQ).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  createTestState,
  flushAsyncWork,
} from '../../src/testing/fakeKafkaJs';

const { state, reset } = createTestState();
mock.module('kafkajs', () => createFakeKafkaJsModule(state));

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');

async function waitForConsumerEachMessage(timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.consumers[0]?.eachMessage) return;
    await flushAsyncWork(5);
  }
  throw new Error('timed out waiting for durable consumer registration');
}

afterEach(async () => {
  reset();
});

describe('kafkaAdapter — metrics emitter', () => {
  test('records kafka.publish.count and kafka.publish.duration on successful emit', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      topicPrefix: 'm.events',
      metrics,
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'metrics-worker' });
    await flushAsyncWork();

    bus.emit('auth:login', { userId: 'u-1', sessionId: 's-1' });
    await flushAsyncWork();

    const snap = metrics.snapshot();
    const publishOk = snap.counters.find(
      c =>
        c.name === 'kafka.publish.count' &&
        c.labels.topic === 'm.events.auth.login' &&
        c.labels.result === 'success',
    );
    expect(publishOk?.value).toBeGreaterThanOrEqual(1);

    const duration = snap.timings.find(
      t => t.name === 'kafka.publish.duration' && t.labels.topic === 'm.events.auth.login',
    );
    expect(duration?.count).toBeGreaterThanOrEqual(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    const producerConnected = snap.gauges.find(g => g.name === 'kafka.producer.connected');
    expect(producerConnected?.value).toBe(1);
  });

  test('records kafka.publish.count failure label and pending-buffer gauge on send failure', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      metrics,
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'failure-worker' });
    await flushAsyncWork();

    state.producerSendErrors.push(new Error('temporary broker failure'));
    bus.emit('auth:login', { userId: 'u-2', sessionId: 's-2' });
    await flushAsyncWork();

    let snap = metrics.snapshot();
    const publishFail = snap.counters.find(
      c => c.name === 'kafka.publish.count' && c.labels.result === 'failure',
    );
    expect(publishFail?.value).toBeGreaterThanOrEqual(1);

    const pending = snap.gauges.find(g => g.name === 'kafka.pending.size');
    expect(pending?.value).toBeGreaterThanOrEqual(1);

    // Drain returns the buffer to zero — the gauge should reflect that.
    await bus._drainPendingBuffer();
    snap = metrics.snapshot();
    const pendingAfter = snap.gauges.find(g => g.name === 'kafka.pending.size');
    expect(pendingAfter?.value).toBe(0);
  });

  test('records kafka.consume.count + duration when a message is processed', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      topicPrefix: 'm.events',
      metrics,
    });

    bus.on(
      'auth:login',
      () => {
        // handler succeeds
      },
      { durable: true, name: 'consume-worker' },
    );
    await waitForConsumerEachMessage();

    const consumer = state.consumers[0];
    await consumer?.eachMessage?.({
      topic: 'm.events.auth.login',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('k'),
        headers: {},
        value: Buffer.from(JSON.stringify({ userId: 'u', sessionId: 's' })),
      },
      heartbeat: async () => {},
    });

    const snap = metrics.snapshot();
    const consumeCount = snap.counters.find(
      c => c.name === 'kafka.consume.count' && c.labels.topic === 'm.events.auth.login',
    );
    expect(consumeCount?.value).toBeGreaterThanOrEqual(1);

    const consumeDuration = snap.timings.find(
      t => t.name === 'kafka.consume.duration' && t.labels.topic === 'm.events.auth.login',
    );
    expect(consumeDuration?.count).toBeGreaterThanOrEqual(1);
    expect(consumeDuration?.min).toBeGreaterThanOrEqual(0);
  });

  test('records kafka.dlq.count when a message fails to deserialize', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      topicPrefix: 'm.events',
      // default deserializationErrorPolicy === 'dlq'
      metrics,
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'dlq-worker' });
    await waitForConsumerEachMessage();

    const consumer = state.consumers[0];
    // Use a non-JSON payload so the default JSON serializer rejects it.
    await consumer?.eachMessage?.({
      topic: 'm.events.auth.login',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('k'),
        headers: {},
        value: Buffer.from('not-json{'),
      },
      heartbeat: async () => {},
    });

    const snap = metrics.snapshot();
    const dlq = snap.counters.find(
      c =>
        c.name === 'kafka.dlq.count' &&
        c.labels.topic === 'm.events.auth.login' &&
        c.labels.errorType === 'deserialize',
    );
    expect(dlq?.value).toBeGreaterThanOrEqual(1);
  });

  test('publishes kafka.consumer.connected gauge across lifecycle', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      metrics,
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'lifecycle-worker' });
    await waitForConsumerEachMessage();

    // Simulate the consumer joining the group so the GROUP_JOIN listener fires.
    const consumer = state.consumers[0];
    await consumer?.emitEvent?.('consumer.group_join', { payload: { memberId: 'member-1' } });

    let snap = metrics.snapshot();
    let connected = snap.gauges.find(g => g.name === 'kafka.consumer.connected');
    expect(connected?.value).toBe(1);

    await bus.shutdown();
    snap = metrics.snapshot();
    connected = snap.gauges.find(g => g.name === 'kafka.consumer.connected');
    expect(connected?.value).toBe(0);
    const producer = snap.gauges.find(g => g.name === 'kafka.producer.connected');
    // Producer is not eagerly connected in our fake; just assert no spurious 1.
    expect(producer?.value ?? 0).toBe(0);
  });
});
