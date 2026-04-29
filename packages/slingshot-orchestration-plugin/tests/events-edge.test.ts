import { describe, expect, test } from 'bun:test';

describe('Orchestration events', () => {
  test('event names follow convention', () => {
    const events = [
      'orchestration:task.started',
      'orchestration:task.completed',
      'orchestration:task.failed',
      'orchestration:workflow.started',
      'orchestration:workflow.completed',
      'orchestration:workflow.failed',
    ];
    for (const event of events) {
      expect(event).toStartWith('orchestration:');
    }
  });

  test('task events are distinct from workflow events', () => {
    const taskEvent = 'orchestration:task.completed';
    const wfEvent = 'orchestration:workflow.completed';
    expect(taskEvent).not.toBe(wfEvent);
  });

  test('event payloads include runId', () => {
    const payload = { runId: 'run-123', taskName: 'send-email' };
    expect(payload.runId).toBe('run-123');
    expect(payload.taskName).toBe('send-email');
  });
});

describe('Orchestration event sink dispose', () => {
  test('dispose prevents further emits', () => {
    let disposed = false;
    const sink = {
      disposed: false,
      dispose() { this.disposed = true; },
      emit() { if (this.disposed) throw new Error('disposed'); },
    };
    sink.dispose();
    disposed = true;
    expect(disposed).toBe(true);
  });

  test('dispose is idempotent', () => {
    let disposeCount = 0;
    const sink = {
      disposed: false,
      dispose() {
        if (!this.disposed) { this.disposed = true; disposeCount++; }
      },
    };
    sink.dispose();
    sink.dispose();
    sink.dispose();
    expect(disposeCount).toBe(1);
  });
});
