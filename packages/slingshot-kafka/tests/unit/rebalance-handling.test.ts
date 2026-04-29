/**
 * Tests for consumer rebalance handling: pause/resume during rebalance,
 * offset commit during rebalance, heartbeat during rebalance.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createInProcessAdapter, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../../src/testing/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');
const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(() => {
  resetFakeKafkaState();
});

describe('adapter rebalance handling', () => {
  test('rebalance + group_join cycle does not remove consumer from health', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(async () => {});

    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'rebalance-cycle' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0]!;
      expect(bus.health().consumers).toHaveLength(1);

      // Trigger REBALANCING — consumer stays in the health list
      await consumer.emitEvent?.('consumer.rebalancing');
      expect(bus.health().consumers).toHaveLength(1);

      // GROUP_JOIN clears the rebalance state
      await consumer.emitEvent?.('consumer.group_join', {
        payload: { memberId: 'new-member-1' },
      });

      // Consumer still present in health after group join
      expect(bus.health().consumers).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('rebalance during in-flight handler flushes offset after handler completes', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    let releaseHandler: (() => void) | null = null;
    const handlerStarted = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const listener = mock(async () => {
      releaseHandler?.();
      await new Promise(r => setTimeout(r, 30));
    });

    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'rebalance-offset-flush' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0]!;

      const envelope = createRawEventEnvelope('auth:login', { userId: 'rb', sessionId: 'rb' });
      const inflight = consumer.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 3,
        message: {
          offset: '55',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      await handlerStarted;
      // Trigger rebalance while handler is running
      await consumer.emitEvent?.('consumer.rebalancing');
      await inflight?.catch(() => {});

      // After handler completes, offset 56 should be committed
      const committed = consumer.commitOffsetCallArgs.flat();
      expect(committed.some(o => o.offset === '56' && o.partition === 3)).toBe(true);

      // GROUP_JOIN clears rebalance and resumes
      await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'm-2' } });
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('heartbeats continue during rebalance quiesce', async () => {
    let releaseHandler: (() => void) | null = null;
    const handlerStarted = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const listener = mock(async () => {
      handlerStarted;
      await new Promise(r => setTimeout(r, 30));
    });

    const heartbeat = mock(async () => {});

    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    bus.on('auth:login', listener, { durable: true, name: 'rebalance-heartbeat' });
    await flushAsyncWork();

    const consumer = fakeKafkaState.consumers[0]!;
    const envelope = createRawEventEnvelope('auth:login', { userId: 'hb', sessionId: 'hb' });
    const inflight = consumer.eachMessage?.({
      topic: 'slingshot.events.auth.login',
      partition: 0,
      message: {
        offset: '10',
        key: null,
        headers: {},
        value: Buffer.from(JSON.stringify(envelope)),
      },
      heartbeat,
    });

    // Trigger rebalance — heartbeats should keep firing
    await consumer.emitEvent?.('consumer.rebalancing');
    await inflight?.catch(() => {});

    // Heartbeats have been called at least once
    expect(heartbeat).toHaveBeenCalled();

    // Clean up
    await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'm-hb' } });
  });
});

describe('connector rebalance handling', () => {
  test('connector rebalance cycle does not break message processing', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'incoming.rebal-conn', groupId: 'rebal-conn-group', handler }],
    });

    try {
      await connectors.start(bus);
      expect(connectors.health().started).toBe(true);

      const consumer = fakeKafkaState.consumers[0]!;

      // Send a message first
      await consumer.eachMessage?.({
        topic: 'incoming.rebal-conn',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'pre-rebal' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);

      // Trigger rebalance
      await consumer.emitEvent?.('consumer.rebalancing');

      // GROUP_JOIN resumes
      await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'c-member' } });

      // Connector is still healthy after rebalance cycle
      expect(connectors.health().started).toBe(true);

      // Messages can still be processed after rebalance
      await consumer.eachMessage?.({
        topic: 'incoming.rebal-conn',
        partition: 0,
        message: {
          offset: '1',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'post-rebal' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await connectors.stop();
    }
  });

  test('connector rebalance flushing commits pending offsets', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'incoming.rebal-flush', groupId: 'rebal-flush-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0]!;

      // Process a message so there's a pending offset
      await consumer.eachMessage?.({
        topic: 'incoming.rebal-flush',
        partition: 2,
        message: {
          offset: '20',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'flush-me' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Trigger rebalance — pending offset should flush
      await consumer.emitEvent?.('consumer.rebalancing');

      const offsets = consumer.commitOffsetCallArgs.flat();
      // Offset 21 should have been committed (next-after-20 on partition 2)
      expect(offsets.some(o => o.offset === '21' && o.partition === 2)).toBe(true);

      // GROUP_JOIN resumes
      await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'm-flush' } });
      expect(connectors.health().started).toBe(true);
    } finally {
      await connectors.stop();
    }
  });
});
