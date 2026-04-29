/**
 * Unified metrics emitter integration tests for slingshot-bullmq.
 *
 * Wires an in-process MetricsEmitter into the BullMQ adapter and asserts that
 * publish/consume counters, durations, dlq counters, and pending-buffer /
 * worker-paused gauges land in the snapshot after a representative workload.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventSchemaRegistry,
  createInProcessMetricsEmitter,
} from '@lastshotlabs/slingshot-core';
import { createFakeBullMQModule, fakeBullMQState } from './helpers/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

describe('createBullMQAdapter — metrics emitter', () => {
  test('records bullmq.publish.count + duration on successful enqueue', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, () => {}, { durable: true, name: 'pub-worker' });
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    // Allow the addWithTimeout promise to settle.
    await new Promise(r => setTimeout(r, 10));

    const snap = metrics.snapshot();
    const publish = snap.counters.find(c => c.name === 'bullmq.publish.count');
    expect(publish?.value).toBeGreaterThanOrEqual(1);
    expect(publish?.labels.queue).toBeTruthy();

    const duration = snap.timings.find(t => t.name === 'bullmq.publish.duration');
    expect(duration?.count).toBeGreaterThanOrEqual(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    await bus.shutdown();
  });

  test('records bullmq.consume.count success + duration when worker completes', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on(
      'auth:login' as any,
      () => {
        // success
      },
      { durable: true, name: 'consume-worker' },
    );
    const queueName = fakeBullMQState.queues[0].name;
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', {
      key: 'auth:login',
      payload: { userId: 'u1' },
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
    const consume = snap.counters.find(
      c =>
        c.name === 'bullmq.consume.count' &&
        c.labels.queue === queueName &&
        c.labels.result === 'success',
    );
    expect(consume?.value).toBeGreaterThanOrEqual(1);

    const duration = snap.timings.find(
      t => t.name === 'bullmq.consume.duration' && t.labels.queue === queueName,
    );
    expect(duration?.count).toBeGreaterThanOrEqual(1);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    await bus.shutdown();
  });

  test('records bullmq.consume.count failure when worker throws', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on(
      'auth:login' as any,
      () => {
        throw new Error('downstream unreachable');
      },
      { durable: true, name: 'failing-worker' },
    );
    const queueName = fakeBullMQState.queues[0].name;
    await expect(
      fakeBullMQState.dispatchJob(queueName, 'auth:login', {
        key: 'auth:login',
        payload: { userId: 'u1' },
        meta: {
          eventId: 'e1',
          occurredAt: new Date().toISOString(),
          ownerPlugin: 'test',
          exposure: ['internal'],
          scope: null,
          requestTenantId: null,
        },
      }),
    ).rejects.toThrow('downstream unreachable');

    const snap = metrics.snapshot();
    const fail = snap.counters.find(
      c =>
        c.name === 'bullmq.consume.count' &&
        c.labels.queue === queueName &&
        c.labels.result === 'failure',
    );
    expect(fail?.value).toBeGreaterThanOrEqual(1);

    await bus.shutdown();
  });

  test('records bullmq.dlq.count on strict-validation failure', async () => {
    const registry = createEventSchemaRegistry();
    registry.register('auth:login', z.object({ userId: z.string(), sessionId: z.string() }));

    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({
      connection: {},
      validation: 'strict',
      schemaRegistry: registry,
      metrics,
    });
    bus.on('auth:login' as any, () => {}, { durable: true, name: 'dlq-worker' });

    const queueName = fakeBullMQState.queues[0].name;
    // Invalid payload (missing sessionId) -- routed to validation DLQ, not retried.
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', { userId: 'u1' });

    const snap = metrics.snapshot();
    const dlq = snap.counters.find(
      c => c.name === 'bullmq.dlq.count' && c.labels.queue === queueName,
    );
    expect(dlq?.value).toBeGreaterThanOrEqual(1);

    await bus.shutdown();
  });

  test('records bullmq.pending.size gauge when enqueue fails', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, () => {}, { durable: true, name: 'pending-worker' });

    fakeBullMQState.nextAddError(Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' }));
    bus.emit('auth:login' as any, { userId: 'u1' } as any);
    await new Promise(r => setTimeout(r, 10));

    const snap = metrics.snapshot();
    const pending = snap.gauges.find(g => g.name === 'bullmq.pending.size');
    expect(pending?.value).toBeGreaterThanOrEqual(1);

    await bus.shutdown();
  });

  test('publishes bullmq.worker.paused gauge on worker error', async () => {
    const metrics = createInProcessMetricsEmitter();
    const bus = createBullMQAdapter({ connection: {}, metrics });
    bus.on('auth:login' as any, () => {}, { durable: true, name: 'error-worker' });
    const workerRecord = fakeBullMQState.workers[0];
    for (const handler of workerRecord.errorHandlers) handler(new Error('worker crashed'));

    const snap = metrics.snapshot();
    const paused = snap.gauges.find(g => g.name === 'bullmq.worker.paused');
    expect(paused?.value).toBe(1);

    await bus.shutdown();
  });
});
