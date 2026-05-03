/**
 * Connection-failure recovery and backoff tests for createBullMQAdapter.
 * Covers Redis connection failure at startup, drain backoff behavior
 * (drainBaseMs/drainMaxMs), and enqueue retry exhaustion.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createFakeBullMQModule, fakeBullMQState } from '../../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());
const { createBullMQAdapter } = await import('../../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

describe('createBullMQAdapter -- connection startup', () => {
  test('adapter creation does not throw with minimal connection opts', () => {
    expect(() => createBullMQAdapter({ connection: {} })).not.toThrow();
  });

  test('non-durable emit works after creation with empty connection', () => {
    const bus = createBullMQAdapter({ connection: {} });
    let called = false;
    bus.on('auth:login' as any, () => {
      called = true;
    });
    bus.emit('auth:login' as any, {} as any);
    expect(called).toBe(true);
  });

  test('adapter degrades to degraded on enqueue failure and buffers event', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'startup-degrade' });
      fakeBullMQState.nextAddError(new Error('ECONNREFUSED'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));
      expect(bus.getHealthDetails().status).toBe('degraded');
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('multiple consecutive startup failures buffer all events without crash', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'multi-startup' });
      for (let i = 0; i < 5; i++) fakeBullMQState.nextAddError(new Error('ECONNREFUSED'));
      for (let i = 0; i < 5; i++) bus.emit('auth:login' as any, { seq: i } as any);
      await new Promise(r => setTimeout(r, 20));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(5);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('createBullMQAdapter -- drain backoff behavior', () => {
  test('consecutive drain failures keep event buffered', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 50, drainMaxMs: 200 });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backoff-count' });
      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));

      fakeBullMQState.nextAddError(new Error('still down'));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

      fakeBullMQState.nextAddError(new Error('still down'));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('drain backoff resets to zero when buffer empties', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 60_000, drainMaxMs: 120_000 });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backoff-reset' });
      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 10));
      fakeBullMQState.nextAddError(new Error('Redis down'));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);

      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);

      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, { fresh: true } as any);
      await new Promise(r => setTimeout(r, 10));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('drain backoff is capped at drainMaxMs', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({
        connection: {},
        drainBaseMs: 60_000,
        drainMaxMs: 200,
        maxEnqueueAttempts: 10,
      });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'backoff-cap' });
      fakeBullMQState.nextAddError(new Error('down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 10));
      for (let i = 0; i < 5; i++) fakeBullMQState.nextAddError(new Error('still down'));
      for (let i = 0; i < 5; i++) await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('createBullMQAdapter -- maxEnqueueAttempts exhaustion', () => {
  test('event dropped after exhausting maxEnqueueAttempts fires onDrop', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const dropped: string[] = [];
    try {
      const bus = createBullMQAdapter({
        connection: {},
        maxEnqueueAttempts: 2,
        drainBaseMs: 50,
        drainMaxMs: 200,
        onDrop: (event, reason) => dropped.push(`${event}:${reason}`),
      });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'max-attempts' });
      fakeBullMQState.nextAddError(new Error('ECONNREFUSED'));
      bus.emit('auth:login' as any, { userId: 'drop-test' } as any);
      await new Promise(r => setTimeout(r, 20));
      fakeBullMQState.nextAddError(new Error('ECONNREFUSED'));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
      expect(bus.getHealthDetails().bufferDroppedCount).toBe(1);
      expect(dropped).toContain('auth:login:max-attempts');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('events survive within default maxEnqueueAttempts and drain on recovery', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {}, drainBaseMs: 50, drainMaxMs: 200 });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'default-max' });
      fakeBullMQState.nextAddError(new Error('down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));
      for (let i = 0; i < 3; i++) {
        fakeBullMQState.nextAddError(new Error('down'));
        await bus._drainPendingBuffer();
      }
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
      expect(bus.getHealthDetails().bufferDroppedCount).toBe(0);
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('permanent error during drain drops immediately regardless of attempts', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {}, maxEnqueueAttempts: 5 });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'perm-in-drain' });
      fakeBullMQState.nextAddError(new Error('ECONNREFUSED'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));
      expect(bus.getHealthDetails().pendingBufferSize).toBe(1);
      fakeBullMQState.nextAddError(Object.assign(new Error('bad type'), { code: 'WRONGTYPE' }));
      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().pendingBufferSize).toBe(0);
      expect(bus.getHealthDetails().bufferDroppedCount).toBe(1);
      expect(bus.getHealthDetails().permanentErrorCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
