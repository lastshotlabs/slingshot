import { describe, expect, mock, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createSlingshotEventSink } from '../src/eventSink';
// Import the augmentation so orchestration events are registered on SlingshotEventMap.
import '../src/events';

// ---------------------------------------------------------------------------
// Helper: drain the bus between assertions so async handlers settle.
// ---------------------------------------------------------------------------
async function drain(bus: SlingshotEventBus): Promise<void> {
  const adapter = bus as SlingshotEventBus & { drain?: () => Promise<void> };
  if (typeof adapter.drain === 'function') {
    await adapter.drain();
  }
}

describe('createSlingshotEventSink', () => {
  describe('creation and disposal', () => {
    test('creates a sink with emit, subscribe, and dispose methods', () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      expect(sink).toHaveProperty('emit');
      expect(sink).toHaveProperty('subscribe');
      expect(sink).toHaveProperty('dispose');
      expect(typeof sink.emit).toBe('function');
      expect(typeof sink.subscribe).toBe('function');
      expect(typeof sink.dispose).toBe('function');
    });

    test('dispose is idempotent', () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      sink.dispose();
      expect(() => sink.dispose()).not.toThrow();
      expect(() => sink.dispose()).not.toThrow();
    });

    test('subscribe after dispose returns a no-op handle and does not register', async () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      sink.dispose();

      const handler = mock(() => {});
      const unsub = sink.subscribe('orchestration.task.started', handler);
      expect(typeof unsub).toBe('function');

      // Emit after dispose — handler should NOT be called
      bus.emit('orchestration.task.started', {
        runId: 'r1',
        task: 't1',
        input: {},
      });
      await drain(bus);
      expect(handler).not.toHaveBeenCalled();

      // The no-op unsubscribe handle should not throw
      expect(() => unsub()).not.toThrow();
    });
  });

  describe('emitting events', () => {
    test('forwards orchestration.task.started to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.task.started', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.started', {
        runId: 'run-1',
        task: 'my-task',
        input: { key: 'value' },
        tenantId: 'tenant-abc',
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'run-1', task: 'my-task' });
    });

    test('forwards orchestration.task.completed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.task.completed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.completed', {
        runId: 'run-2',
        task: 'my-task',
        output: { result: 42 },
        durationMs: 100,
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'run-2', durationMs: 100 });
    });

    test('forwards orchestration.task.failed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.task.failed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.failed', {
        runId: 'run-3',
        task: 'my-task',
        error: { message: 'oops', name: 'Error' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'run-3' });
    });

    test('forwards orchestration.workflow.started to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.workflow.started', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.workflow.started', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        input: { email: 'test@example.com' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'wf-run-1', workflow: 'onboard-user' });
    });

    test('forwards orchestration.workflow.completed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.workflow.completed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.workflow.completed', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        output: { userId: 'usr_123' },
        durationMs: 500,
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'wf-run-1', durationMs: 500 });
    });

    test('forwards orchestration.workflow.failed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.workflow.failed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.workflow.failed', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        error: { message: 'step failed', name: 'Error' },
        failedStep: 'send-welcome',
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'wf-run-1' });
    });

    test('forwards orchestration.step.completed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.step.completed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.step.completed', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        step: 'resize-image',
        output: { ok: true },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'wf-run-1', step: 'resize-image' });
    });

    test('forwards orchestration.step.failed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.step.failed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.step.failed', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        step: 'resize-image',
        error: { message: 'timeout', name: 'Error' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });

    test('forwards orchestration.step.skipped to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.step.skipped', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.step.skipped', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        step: 'send-welcome',
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });

    test('forwards orchestration.task.progress to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.task.progress', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.progress', {
        runId: 'run-1',
        task: 'my-task',
        data: { percent: 50, message: 'halfway' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });

    test('forwards orchestration.workflow.hookError to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.workflow.hookError', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.workflow.hookError', {
        runId: 'wf-run-1',
        workflow: 'onboard-user',
        hook: 'onComplete',
        error: { message: 'hook failed', name: 'Error' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });

    test('forwards orchestration.task.postReturnError to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.task.postReturnError', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.postReturnError', {
        runId: 'run-1',
        task: 'my-task',
        error: { message: 'cleanup failed', name: 'Error' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });

    test('forwards orchestration.bullmq.snapshotMalformed to the bus', async () => {
      const bus = createInProcessAdapter();
      const received: unknown[] = [];

      bus.on('orchestration.bullmq.snapshotMalformed', (p: unknown) => received.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.bullmq.snapshotMalformed', {
        runId: 'run-1',
        malformedKey: 'snapshot:abc',
        error: { message: 'corrupt data' },
      });

      await drain(bus);
      expect(received).toHaveLength(1);
    });
  });

  describe('multiple events', () => {
    test('emits multiple event types to independent listeners', async () => {
      const bus = createInProcessAdapter();
      const started: unknown[] = [];
      const completed: unknown[] = [];
      const failed: unknown[] = [];

      bus.on('orchestration.task.started', (p: unknown) => started.push(p));
      bus.on('orchestration.task.completed', (p: unknown) => completed.push(p));
      bus.on('orchestration.task.failed', (p: unknown) => failed.push(p));

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      sink.emit('orchestration.task.started', { runId: 'r2', task: 't1', input: {} });
      sink.emit('orchestration.task.completed', {
        runId: 'r1',
        task: 't1',
        output: {},
        durationMs: 10,
      });
      sink.emit('orchestration.task.failed', {
        runId: 'r3',
        task: 't2',
        error: { message: 'fail', name: 'Error' },
      });

      await drain(bus);

      expect(started).toHaveLength(2);
      expect(completed).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });

    test('events are forwarded in order', async () => {
      const bus = createInProcessAdapter();
      const order: string[] = [];

      bus.on('orchestration.task.started', (p: unknown) => {
        order.push((p as { runId: string }).runId);
      });

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      sink.emit('orchestration.task.started', { runId: 'r2', task: 't2', input: {} });
      sink.emit('orchestration.task.started', { runId: 'r3', task: 't3', input: {} });

      await drain(bus);
      expect(order).toEqual(['r1', 'r2', 'r3']);
    });
  });

  describe('concurrent emit operations', () => {
    test('handles many emits in rapid succession without dropping events', async () => {
      const bus = createInProcessAdapter();
      const received: string[] = [];

      bus.on('orchestration.task.started', (p: unknown) => {
        received.push((p as { runId: string }).runId);
      });

      const sink = createSlingshotEventSink(bus);
      const count = 100;

      for (let i = 0; i < count; i++) {
        sink.emit('orchestration.task.started', {
          runId: `r${i}`,
          task: 'my-task',
          input: {},
        });
      }

      await drain(bus);
      expect(received).toHaveLength(count);
      // Verify no duplicates and all IDs are present
      const ids = new Set(received);
      expect(ids.size).toBe(count);
    });

    test('handles concurrent emits through Promise.all without race conditions', async () => {
      const bus = createInProcessAdapter();
      const received: string[] = [];

      // Use an async handler that yields to test concurrency
      bus.on('orchestration.task.started', async (p: unknown) => {
        await new Promise(resolve => setImmediate(resolve));
        received.push((p as { runId: string }).runId);
      });

      const sink = createSlingshotEventSink(bus);
      const count = 50;

      // Emit concurrently from multiple "callers"
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          Promise.resolve().then(() => {
            sink.emit('orchestration.task.started', {
              runId: `concurrent-r${i}`,
              task: 'my-task',
              input: {},
            });
          }),
        ),
      );

      await drain(bus);
      expect(received).toHaveLength(count);
    });

    test('concurrent task.started and task.completed emits are all delivered', async () => {
      const bus = createInProcessAdapter();
      const started: string[] = [];
      const completed: string[] = [];

      bus.on('orchestration.task.started', (p: unknown) => {
        started.push((p as { runId: string }).runId);
      });
      bus.on('orchestration.task.completed', (p: unknown) => {
        completed.push((p as { runId: string }).runId);
      });

      const sink = createSlingshotEventSink(bus);

      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          Promise.resolve().then(() => {
            sink.emit('orchestration.task.started', {
              runId: `r${i}`,
              task: 'my-task',
              input: {},
            });
            sink.emit('orchestration.task.completed', {
              runId: `r${i}`,
              task: 'my-task',
              output: { index: i },
              durationMs: i,
            });
          }),
        ),
      );

      await drain(bus);
      expect(started).toHaveLength(30);
      expect(completed).toHaveLength(30);
    });
  });

  describe('dispose prevents further subscriptions', () => {
    test('dispose removes all existing subscriptions', async () => {
      const bus = createInProcessAdapter();
      const captured: unknown[] = [];
      const handler = (p: unknown) => {
        captured.push(p);
      };

      const sink = createSlingshotEventSink(bus);
      sink.subscribe('orchestration.task.started', handler);
      sink.subscribe('orchestration.task.completed', handler);

      // Emit before dispose — handler should be called
      bus.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);
      expect(captured).toHaveLength(1);

      sink.dispose();

      // Emit after dispose — handler should NOT be called
      bus.emit('orchestration.task.started', { runId: 'r2', task: 't1', input: {} });
      bus.emit('orchestration.task.completed', {
        runId: 'r1',
        task: 't1',
        output: {},
        durationMs: 10,
      });
      await drain(bus);
      expect(captured).toHaveLength(1);
    });

    test('emit still works after dispose (fire-and-forget for in-flight races)', () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      sink.dispose();

      expect(() => {
        sink.emit('orchestration.task.started', {
          runId: 'r1',
          task: 't1',
          input: {},
        });
      }).not.toThrow();
    });

    test('individual unsubscribe handles work independently', async () => {
      const bus = createInProcessAdapter();
      const captured: unknown[] = [];
      const handlerA = (p: unknown) => {
        captured.push((p as { runId: string }).runId);
      };
      const handlerB = mock(() => {});

      const sink = createSlingshotEventSink(bus);
      const unsubA = sink.subscribe('orchestration.task.started', handlerA);
      sink.subscribe('orchestration.task.started', handlerB);

      // Unsubscribe handlerA only
      unsubA();

      bus.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);

      // handlerA should not have been called, handlerB should have been
      expect(captured).toEqual([]);
      expect(handlerB).toHaveBeenCalledTimes(1);

      // Calling unsubscribe handle again is a no-op
      expect(() => unsubA()).not.toThrow();

      sink.dispose();
    });
  });

  describe('error isolation', () => {
    test('does not crash when eventBus.emit throws', () => {
      const throwingBus: SlingshotEventBus = {
        emit() {
          throw new Error('bus is broken');
        },
        on: mock(() => {}),
      } as unknown as SlingshotEventBus;

      const sink = createSlingshotEventSink(throwingBus);
      expect(() => {
        sink.emit('orchestration.task.started', {
          runId: 'run-x',
          task: 'task-x',
          input: {},
        });
      }).not.toThrow();
    });

    test('one bad bus handler does not prevent other handlers from receiving events', async () => {
      const bus = createInProcessAdapter();
      const received: string[] = [];

      bus.on('orchestration.task.started', () => {
        throw new Error('bad handler');
      });
      bus.on('orchestration.task.started', (p: unknown) => {
        received.push((p as { runId: string }).runId);
      });

      const sink = createSlingshotEventSink(bus);
      sink.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);

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

      sink.dispose();
    });

    test('does not crash when bus.off is not available during unsubscribe', async () => {
      const minimalBus: SlingshotEventBus = {
        emit: mock(() => {}),
        on: mock(() => {}),
      } as unknown as SlingshotEventBus;

      const sink = createSlingshotEventSink(minimalBus);
      const unsub = sink.subscribe('orchestration.task.started', () => {});
      expect(typeof unsub).toBe('function');

      // Calling unsubscribe should not throw even without bus.off
      expect(() => unsub()).not.toThrow();
    });
  });

  describe('event type safety', () => {
    test('sink.emit accepts correct payload shapes for all event types (compile-time check)', () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      // Each of these compiles only because the payload matches the declared type.
      // If the module augmentation were missing, TypeScript would flag
      // these event names as not existing on SlingshotEventMap.
      sink.emit('orchestration.task.started', { runId: 'r', task: 't', input: {} });
      sink.emit('orchestration.task.completed', { runId: 'r', task: 't', output: {}, durationMs: 1 });
      sink.emit('orchestration.task.failed', {
        runId: 'r',
        task: 't',
        error: { message: 'm', name: 'Error' },
      });
      sink.emit('orchestration.workflow.started', { runId: 'r', workflow: 'w', input: {} });
      sink.emit('orchestration.workflow.completed', {
        runId: 'r',
        workflow: 'w',
        output: {},
        durationMs: 1,
      });
      sink.emit('orchestration.workflow.failed', {
        runId: 'r',
        workflow: 'w',
        error: { message: 'm', name: 'Error' },
      });
      sink.emit('orchestration.step.completed', { runId: 'r', workflow: 'w', step: 's', output: {} });
      sink.emit('orchestration.step.failed', {
        runId: 'r',
        workflow: 'w',
        step: 's',
        error: { message: 'm', name: 'Error' },
      });
      sink.emit('orchestration.step.skipped', { runId: 'r', workflow: 'w', step: 's' });
      sink.emit('orchestration.task.progress', {
        runId: 'r',
        task: 't',
        data: { percent: 50 },
      });
      sink.emit('orchestration.workflow.hookError', {
        runId: 'r',
        workflow: 'w',
        hook: 'onStart',
        error: { message: 'm', name: 'Error' },
      });
      sink.emit('orchestration.task.postReturnError', {
        runId: 'r',
        task: 't',
        error: { message: 'm', name: 'Error' },
      });
      sink.emit('orchestration.bullmq.snapshotMalformed', {
        runId: 'r',
        malformedKey: 'k',
        error: { message: 'm' },
      });

      // If we got here without a compile error, type safety is verified
      expect(true).toBe(true);
    });

    test('subscribe handler receives correctly typed payload', async () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      let capturedRunId: string | undefined;
      let capturedTask: string | undefined;

      sink.subscribe('orchestration.task.started', (payload) => {
        // TypeScript infers payload as OrchestrationEventMap['orchestration.task.started']
        capturedRunId = payload.runId;
        capturedTask = payload.task;
      });

      bus.emit('orchestration.task.started', {
        runId: 'type-safe-run',
        task: 'type-safe-task',
        input: { foo: 'bar' },
      });

      await drain(bus);
      expect(capturedRunId).toBe('type-safe-run');
      expect(capturedTask).toBe('type-safe-task');

      sink.dispose();
    });

    test('subscribe handler receives completed event payload with correct shape', async () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      let captured: unknown;

      sink.subscribe('orchestration.task.completed', (payload) => {
        captured = payload;
      });

      bus.emit('orchestration.task.completed', {
        runId: 'r1',
        task: 't1',
        output: { result: 'ok' },
        durationMs: 42,
      });

      await drain(bus);

      // Verify the full payload shape
      expect(captured).toMatchObject({
        runId: 'r1',
        task: 't1',
        output: { result: 'ok' },
        durationMs: 42,
      });

      sink.dispose();
    });

    test('subscribe handler receives failed event with error details', async () => {
      const bus = createInProcessAdapter();
      const sink = createSlingshotEventSink(bus);

      let capturedError: unknown;

      sink.subscribe('orchestration.task.failed', (payload) => {
        capturedError = payload.error;
      });

      bus.emit('orchestration.task.failed', {
        runId: 'r1',
        task: 't1',
        error: { message: 'something broke', name: 'Error' },
      });

      await drain(bus);
      expect(capturedError).toMatchObject({
        message: 'something broke',
        name: 'Error',
      });

      sink.dispose();
    });
  });

  describe('subscribe handle lifecycle', () => {
    test('dispose removes all subscriptions even when individual handles exist', async () => {
      const bus = createInProcessAdapter();
      const captured: unknown[] = [];

      const sink = createSlingshotEventSink(bus);
      sink.subscribe('orchestration.task.started', (p: unknown) => captured.push(p));

      sink.dispose();

      bus.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);
      expect(captured).toEqual([]);
    });

    test('unsubscribe handle returned by subscribe removes single listener', async () => {
      const bus = createInProcessAdapter();
      const calls: string[] = [];

      const sink = createSlingshotEventSink(bus);
      const unsub = sink.subscribe('orchestration.task.started', (p: unknown) =>
        calls.push((p as { runId: string }).runId),
      );

      unsub();

      bus.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);
      expect(calls).toEqual([]);

      sink.dispose();
    });

    test('unsubscribe handle is idempotent', async () => {
      const bus = createInProcessAdapter();
      const calls: string[] = [];

      const sink = createSlingshotEventSink(bus);
      const unsub = sink.subscribe('orchestration.task.started', (p: unknown) =>
        calls.push((p as { runId: string }).runId),
      );

      unsub();
      unsub();
      unsub();

      bus.emit('orchestration.task.started', { runId: 'r1', task: 't1', input: {} });
      await drain(bus);
      expect(calls).toEqual([]);

      sink.dispose();
    });
  });
});
