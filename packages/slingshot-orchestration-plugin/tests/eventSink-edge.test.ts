// packages/slingshot-orchestration-plugin/tests/eventSink-edge.test.ts
//
// Edge cases for the Slingshot event sink: graceful handling when the bus
// does not have `off`, error isolation in dispose, event ordering guarantees,
// and post-dispose behavior.
import { describe, expect, mock, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createSlingshotEventSink } from '../src/eventSink';
import '../src/events';

describe('createSlingshotEventSink — edge cases', () => {
  test('does not crash when bus.off is not available', async () => {
    // Build a minimal bus without `off`
    const minimalBus: SlingshotEventBus = {
      emit: mock(() => {}),
      on: mock(() => {}),
    } as unknown as SlingshotEventBus;

    const sink = createSlingshotEventSink(minimalBus);

    // Subscribe should work (it tries to call off during unsubscribe, gracefully)
    const unsub = sink.subscribe('orchestration.task.started', () => {});
    expect(typeof unsub).toBe('function');

    // Calling the unsubscribe handle should not throw even without bus.off
    expect(() => unsub()).not.toThrow();
  });

  test('dispose is idempotent and does not throw on repeated calls', () => {
    const bus = createInProcessAdapter();
    const sink = createSlingshotEventSink(bus);

    sink.dispose();
    expect(() => sink.dispose()).not.toThrow();
    expect(() => sink.dispose()).not.toThrow();
  });

  test('subscribe after dispose returns a no-op handle and does not throw', () => {
    const bus = createInProcessAdapter();
    const sink = createSlingshotEventSink(bus);

    sink.dispose();
    const handler = mock(() => {});
    const unsub = sink.subscribe('orchestration.task.started', handler);
    expect(typeof unsub).toBe('function');

    // Calling the no-op handle should not throw
    expect(() => unsub()).not.toThrow();
  });

  test('emit after dispose still works (fire-and-forget)', () => {
    const bus = createInProcessAdapter();
    const sink = createSlingshotEventSink(bus);

    sink.dispose();

    // emit should not throw after dispose
    expect(() => {
      sink.emit('orchestration.task.started', {
        runId: 'r1',
        task: 't1',
        input: {},
      });
    }).not.toThrow();
  });

  test('events from sink are forwarded in order', async () => {
    const bus = createInProcessAdapter();
    const received: string[] = [];

    bus.on('orchestration.task.started', (p: unknown) => {
      received.push((p as { runId: string }).runId);
    });

    const sink = createSlingshotEventSink(bus);

    // Emit three events in sequence
    sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
    sink.emit('orchestration.task.started', { runId: 'r2', task: 't2', input: {} });
    sink.emit('orchestration.task.started', { runId: 'r3', task: 't3', input: {} });

    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    expect(received).toEqual(['r1', 'r2', 'r3']);
  });

  test('one bad handler does not prevent other handlers from receiving events', async () => {
    const bus = createInProcessAdapter();
    const received: string[] = [];

    // Register a handler that throws
    bus.on('orchestration.task.started', () => {
      throw new Error('bad handler');
    });

    // Register a second handler that captures events
    bus.on('orchestration.task.started', (p: unknown) => {
      received.push((p as { runId: string }).runId);
    });

    const sink = createSlingshotEventSink(bus);
    sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });

    await (bus as ReturnType<typeof createInProcessAdapter> & { drain(): Promise<void> }).drain();

    // The good handler should still have received the event
    expect(received).toContain('r1');
  });

  test('subscribe returns unique handles per call', () => {
    const bus = createInProcessAdapter();
    const sink = createSlingshotEventSink(bus);

    const unsub1 = sink.subscribe('orchestration.task.started', () => {});
    const unsub2 = sink.subscribe('orchestration.task.started', () => {});
    const unsub3 = sink.subscribe('orchestration.task.completed', () => {});

    expect(unsub1).not.toBe(unsub2);
    expect(unsub2).not.toBe(unsub3);

    // Clean up
    sink.dispose();
  });
});
