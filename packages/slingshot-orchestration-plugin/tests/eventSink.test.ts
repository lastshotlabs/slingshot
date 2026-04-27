import { describe, expect, mock, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createSlingshotEventSink } from '../src/eventSink';

// Import the augmentation so orchestration events are registered on SlingshotEventMap.
import '../src/events';

describe('createSlingshotEventSink', () => {
  test('forwards orchestration.task.started to the event bus', async () => {
    const bus = createInProcessAdapter();
    const received: unknown[] = [];

    bus.on('orchestration.task.started', (payload) => {
      received.push(payload);
    });

    const sink = createSlingshotEventSink(bus);
    sink.emit('orchestration.task.started', {
      runId: 'run-1',
      task: 'my-task',
      input: { key: 'value' },
      tenantId: 'tenant-abc',
    });

    // Drain pending async listeners before asserting.
    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ runId: 'run-1', task: 'my-task' });
  });

  test('forwards orchestration.task.completed to the event bus', async () => {
    const bus = createInProcessAdapter();
    const received: unknown[] = [];

    bus.on('orchestration.task.completed', (payload) => {
      received.push(payload);
    });

    const sink = createSlingshotEventSink(bus);
    sink.emit('orchestration.task.completed', {
      runId: 'run-2',
      task: 'my-task',
      output: { result: 42 },
      durationMs: 100,
    });

    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ runId: 'run-2', durationMs: 100 });
  });

  test('forwards orchestration.task.failed to the event bus', async () => {
    const bus = createInProcessAdapter();
    const received: unknown[] = [];

    bus.on('orchestration.task.failed', (payload) => {
      received.push(payload);
    });

    const sink = createSlingshotEventSink(bus);
    sink.emit('orchestration.task.failed', {
      runId: 'run-3',
      task: 'my-task',
      error: { message: 'oops', name: 'Error' },
    });

    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ runId: 'run-3' });
  });

  test('does not crash when eventBus.emit throws', () => {
    // Build a bus that throws on emit.
    const throwingBus: SlingshotEventBus = {
      emit() {
        throw new Error('bus is broken');
      },
      on: mock(() => {}),
      off: mock(() => {}),
    } as unknown as SlingshotEventBus;

    const sink = createSlingshotEventSink(throwingBus);

    // Should not propagate the exception — the sink is fire-and-forget.
    expect(() => {
      sink.emit('orchestration.task.started', {
        runId: 'run-x',
        task: 'task-x',
        input: {},
      });
    }).not.toThrow();
  });

  test('multiple events are forwarded independently to the event bus', async () => {
    const bus = createInProcessAdapter();
    const startedEvents: unknown[] = [];
    const completedEvents: unknown[] = [];

    bus.on('orchestration.task.started', (p) => startedEvents.push(p));
    bus.on('orchestration.task.completed', (p) => completedEvents.push(p));

    const sink = createSlingshotEventSink(bus);
    sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
    sink.emit('orchestration.task.started', { runId: 'r2', task: 't1', input: {} });
    sink.emit('orchestration.task.completed', {
      runId: 'r1',
      task: 't1',
      output: {},
      durationMs: 10,
    });

    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    expect(startedEvents).toHaveLength(2);
    expect(completedEvents).toHaveLength(1);
  });
});
