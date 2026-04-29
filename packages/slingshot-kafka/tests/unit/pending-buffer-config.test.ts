import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { KafkaAdapterDropEvent } from '../../src/kafkaAdapter';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../../src/testing/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');

afterEach(() => {
  resetFakeKafkaState();
});

describe('kafkaAdapter pendingBufferSize config', () => {
  test('uses pendingBufferSize=50 to bound the reconnect buffer and drops at the 51st event', async () => {
    const drops: KafkaAdapterDropEvent[] = [];
    const onDrop = mock((event: KafkaAdapterDropEvent) => {
      drops.push(event);
    });

    const errSpy = mock((..._args: unknown[]) => {});
    const originalErr = console.error;
    console.error = errSpy;

    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        pendingBufferSize: 50,
        onDrop,
      });

      bus.on('auth:login', () => {}, { durable: true, name: 'buffer-cap-worker' });
      await flushAsyncWork();

      // Force every send to fail so the events accumulate in the pending buffer.
      const failures = 51;
      for (let i = 0; i < failures; i++) {
        fakeKafkaState.producerSendErrors.push(new Error(`send failed ${i}`));
      }

      for (let i = 0; i < failures; i++) {
        bus.emit('auth:login', { userId: `u-${i}`, sessionId: `s-${i}` });
      }
      await flushAsyncWork();

      // Buffer should have filled to its cap; the 51st event must have been dropped.
      expect(bus.health().pendingBufferSize).toBe(50);
      expect(drops).toHaveLength(1);
      expect(drops[0]?.reason).toBe('pending-buffer-full');
      expect(drops[0]?.event).toBe('auth:login');
      expect(bus.health().droppedMessages.byReason['pending-buffer-full']).toBe(1);
      expect(bus.health().droppedMessages.totalDrops).toBe(1);
      expect(bus.health().droppedMessages.lastDropReason).toBe('pending-buffer-full');
    } finally {
      console.error = originalErr;
    }
  });

  test('rejects pendingBufferSize less than 1 via Zod schema validation', () => {
    expect(() =>
      createKafkaAdapter({
        brokers: ['localhost:19092'],
        pendingBufferSize: 0,
      }),
    ).toThrow();
  });

  test('defaults to 1000 when pendingBufferSize is unset', async () => {
    const drops: KafkaAdapterDropEvent[] = [];
    const onDrop = mock((event: KafkaAdapterDropEvent) => {
      drops.push(event);
    });

    const errSpy = mock((..._args: unknown[]) => {});
    const originalErr = console.error;
    console.error = errSpy;

    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        onDrop,
      });

      bus.on('auth:login', () => {}, { durable: true, name: 'buffer-default-worker' });
      await flushAsyncWork();

      // Push 1000 failures to fill the default-sized buffer, then 1 more to trigger a drop.
      const failures = 1001;
      for (let i = 0; i < failures; i++) {
        fakeKafkaState.producerSendErrors.push(new Error(`send failed ${i}`));
      }

      for (let i = 0; i < failures; i++) {
        bus.emit('auth:login', { userId: `u-${i}`, sessionId: `s-${i}` });
      }
      await flushAsyncWork();

      expect(bus.health().pendingBufferSize).toBe(1000);
      expect(drops).toHaveLength(1);
      expect(drops[0]?.reason).toBe('pending-buffer-full');
    } finally {
      console.error = originalErr;
    }
  });
});
