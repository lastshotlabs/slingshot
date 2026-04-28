import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { Logger } from '@lastshotlabs/slingshot-core';

import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { createOrchestrationRuntime } from '../src/runtime';
import type { OrchestrationEventMap, OrchestrationEventSink } from '../src/types';

interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const make = (base: Record<string, unknown> | undefined): Logger => ({
    debug(msg, fields) {
      logs.push({ level: 'debug', msg, fields: { ...base, ...fields } });
    },
    info(msg, fields) {
      logs.push({ level: 'info', msg, fields: { ...base, ...fields } });
    },
    warn(msg, fields) {
      logs.push({ level: 'warn', msg, fields: { ...base, ...fields } });
    },
    error(msg, fields) {
      logs.push({ level: 'error', msg, fields: { ...base, ...fields } });
    },
    child(fields) {
      return make({ ...base, ...fields });
    },
  });
  return { logger: make(undefined), logs };
}

describe('task post-return error visibility (P-ORCH-1)', () => {
  test('post-handler rejection is surfaced via Logger and the event sink', async () => {
    const failingTask = defineTask({
      name: 'failing-post-return-task',
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      async handler() {
        throw new Error('boom');
      },
    });

    const events: Array<{
      name: keyof OrchestrationEventMap;
      payload: OrchestrationEventMap[keyof OrchestrationEventMap];
    }> = [];
    const eventSink: OrchestrationEventSink = {
      emit(name, payload) {
        events.push({ name, payload });
      },
    };
    const { logger, logs } = createCapturingLogger();

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1, eventSink, logger }),
      tasks: [failingTask],
    });

    const handle = await runtime.runTask(failingTask, {});
    await expect(handle.result()).rejects.toThrow('boom');

    // Allow microtasks to drain post-return error reporter
    await new Promise(r => setTimeout(r, 10));

    const errorLog = logs.find(l => l.msg === 'orchestration.task.postReturnError');
    expect(errorLog).toBeDefined();
    expect(errorLog?.level).toBe('error');
    expect(errorLog?.fields).toMatchObject({ task: 'failing-post-return-task' });

    const sinkEvent = events.find(e => e.name === 'orchestration.task.postReturnError');
    expect(sinkEvent).toBeDefined();
    expect((sinkEvent?.payload as { task: string }).task).toBe('failing-post-return-task');
  });
});
