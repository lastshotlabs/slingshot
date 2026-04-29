/**
 * Health-and-metrics tests for createBullMQAdapter.
 *
 * Covers health state transitions, metric counter accuracy, gauge values,
 * and the impact of various operations on health details — complementing
 * the existing coverage in bullmqAdapter.test.ts and metrics.test.ts.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

// ---------------------------------------------------------------------------
// Health state transitions
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — health state transitions', () => {
  test('fresh adapter reports healthy status', () => {
    const bus = createBullMQAdapter({ connection: {} });
    const health = bus.getHealth();
    expect(health.state).toBe('healthy');
    expect(health.component).toBe('slingshot-bullmq');
  });

  test('adapter returns to healthy after buffer drains following a failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-rec' });

      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));
      expect(bus.getHealthDetails().status).toBe('degraded');

      await bus._drainPendingBuffer();
      expect(bus.getHealthDetails().status).toBe('healthy');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('degraded health details include non-zero pendingBufferSize', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-deg' });

      fakeBullMQState.nextAddError(new Error('Redis down'));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));

      const details = bus.getHealthDetails();
      expect(details.status).toBe('degraded');
      expect(details.pendingBufferSize).toBeGreaterThanOrEqual(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Metric counters and gauges
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — metric counters and gauges', () => {
  test('emitter counter increments on successful publish', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'metric-pub' });
    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));

    const snap = metrics.snapshot();
    const publishCount = snap.counters.find(c => c.name === 'bullmq.publish.count');
    expect(publishCount?.value).toBeGreaterThanOrEqual(1);
  });

  test('emitter counter increments on consume success', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'metric-consume' });

    const queueName = fakeBullMQState.queues[0].name;
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', {
      key: 'auth:login',
      payload: {},
      meta: {
        eventId: 'e1',
        occurredAt: new Date().toISOString(),
        ownerPlugin: 'test',
        exposure: ['internal'],
        scope: null,
        requestTenantId: null,
      },
    });

    const snap = metrics.snapshot();
    const consumeCount = snap.counters.find(
      c => c.name === 'bullmq.consume.count' && c.labels.result === 'success',
    );
    expect(consumeCount?.value).toBeGreaterThanOrEqual(1);
  });

  test('pending buffer size gauge reflects buffered events', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'metric-pending' });

    fakeBullMQState.nextAddError(new Error('Redis down'));
    bus.emit('auth:login' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));

    const snap = metrics.snapshot();
    const pendingGauge = snap.gauges.find(g => g.name === 'bullmq.pending.size');
    expect(pendingGauge?.value).toBeGreaterThanOrEqual(1);
  });

  test('worker paused gauge reflects paused workers after error', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'metric-worker-pause' });

    const worker = fakeBullMQState.workers[0];
    for (const handler of worker.errorHandlers) {
      handler(new Error('paused'));
    }

    const snap = metrics.snapshot();
    const pausedGauge = snap.gauges.find(g => g.name === 'bullmq.worker.paused');
    expect(pausedGauge?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Health detail accuracy
// ---------------------------------------------------------------------------

describe('createBullMQAdapter — health detail accuracy', () => {
  test('validationDroppedCount increments on strict-mode validation failure', async () => {
    const { z } = await import('zod');
    const { createEventSchemaRegistry } = await import('@lastshotlabs/slingshot-core');

    const registry = createEventSchemaRegistry();
    registry.register('auth:login', z.object({ userId: z.string() }));

    const bus = createBullMQAdapter({ connection: {}, validation: 'strict', schemaRegistry: registry });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-valid' });

    const queueName = fakeBullMQState.queues[0].name;
    // Invalid payload (userId is number, not string)
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', { userId: 123 });

    expect(bus.getHealthDetails().validationDroppedCount).toBe(1);
  });

  test('permanentErrorCount increments when a permanent error is encountered', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = createBullMQAdapter({ connection: {} });
      bus.on('auth:login' as any, async () => {}, { durable: true, name: 'health-perm' });

      fakeBullMQState.nextAddError(Object.assign(new Error('invalid'), { code: 'EINVAL' }));
      bus.emit('auth:login' as any, {} as any);
      await new Promise(r => setTimeout(r, 20));

      expect(bus.getHealthDetails().permanentErrorCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('checkHealth returns a valid HealthReport with all required fields', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const report = bus.getHealth();
    expect(report).toHaveProperty('component');
    expect(report).toHaveProperty('state');
    expect(report).toHaveProperty('details');
    expect(typeof report.component).toBe('string');
    expect(typeof report.state).toBe('string');
    expect(report.details).toBeDefined();
  });
});
