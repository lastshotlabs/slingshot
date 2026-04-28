import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../helpers/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');

afterEach(() => {
  resetFakeKafkaState();
});

describe('kafkaAdapter.getHealth() / getHealthSnapshot()', () => {
  test('getHealthSnapshot returns { status: "healthy", details } on a freshly created adapter', () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    const snap = bus.getHealthSnapshot();

    expect(snap.status).toBe('healthy');
    expect(snap.details.producerConnected).toBe(false);
    expect(snap.details.adminConnected).toBe(false);
    expect(snap.details.isShutdown).toBe(false);
    expect(snap.details.pendingBufferSize).toBe(0);
    expect(snap.details.consumers).toEqual([]);
    expect(snap.details.droppedMessages.totalDrops).toBe(0);
  });

  test('getHealth() implements HealthCheck — component + state + details', () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    const report = bus.getHealth();
    expect(report.component).toBe('slingshot-kafka');
    expect(report.state).toBe('healthy');
    expect(report.details?.producerConnected).toBe(false);
    expect(report.details?.consumers).toBe(0);
  });

  test('reports unhealthy when the adapter has been shut down', async () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    await bus.shutdown();

    const snap = bus.getHealthSnapshot();
    expect(snap.status).toBe('unhealthy');
    expect(snap.details.isShutdown).toBe(true);
    const report = bus.getHealth();
    expect(report.state).toBe('unhealthy');
  });

  test('reports unhealthy when the producer cannot connect and events are buffered', async () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });

    bus.on('auth:login', () => {}, { durable: true, name: 'snap-worker' });
    await flushAsyncWork();

    // Force the producer's `connect()` to throw — producerConnected stays false
    // and the emit's serialized payload lands in the in-memory pending buffer.
    fakeKafkaState.producerConnectErrors.push(new Error('connect failed'));
    bus.emit('auth:login', { userId: 'u-1', sessionId: 's-1' });
    await flushAsyncWork();

    const snap = bus.getHealthSnapshot();
    expect(snap.details.pendingBufferSize).toBe(1);
    expect(snap.details.producerConnected).toBe(false);
    expect(snap.status).toBe('unhealthy');
  });
});
