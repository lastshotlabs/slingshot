import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask, defineWorkflow, sleep, step } from '@lastshotlabs/slingshot-orchestration';
import type {
  OrchestrationEventMap,
  OrchestrationEventSink,
} from '@lastshotlabs/slingshot-orchestration';
import { createBullMQWorkflowProcessor } from '../src/workflowWorker';

class FakeTaskJob {
  constructor(
    public id: string,
    private readonly result: unknown,
  ) {}

  async waitUntilFinished(_queueEvents: unknown) {
    return this.result;
  }
}

class FakeQueue {
  addCalls: Array<{ name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }> =
    [];
  results: unknown[] = [];

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    const result = this.results.shift() ?? data['input'];
    this.addCalls.push({ name, data, opts });
    return new FakeTaskJob(String(data['runId'] ?? `${name}-${this.addCalls.length}`), result);
  }
}

function createEventCollector() {
  const events: Array<{
    name: keyof OrchestrationEventMap;
    payload: OrchestrationEventMap[keyof OrchestrationEventMap];
  }> = [];

  const eventSink: OrchestrationEventSink = {
    emit(name, payload) {
      events.push({ name, payload });
    },
  };

  return { eventSink, events };
}

describe('bullmq workflow processor', () => {
  test('emits hookError after workflow.completed when onComplete throws', async () => {
    const { eventSink, events } = createEventCollector();
    const queue = new FakeQueue();
    queue.results.push({ delivered: true });

    const task = defineTask({
      name: 'deliver-email-task',
      input: z.object({ email: z.string() }),
      output: z.object({ delivered: z.boolean() }),
      async handler(input) {
        return { delivered: Boolean(input.email) };
      },
    });
    const workflow = defineWorkflow({
      name: 'deliver-email-workflow',
      input: z.object({ email: z.string() }),
      output: z.object({
        'deliver-email-step': z.object({ delivered: z.boolean() }),
      }),
      steps: [step('deliver-email-step', task)],
      onComplete() {
        throw new Error('hook exploded');
      },
    });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[task.name, task]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    const job: {
      id: string;
      name: string;
      data: Record<string, unknown>;
      opts: Record<string, unknown>;
      updateData(nextData: Record<string, unknown>): Promise<void>;
    } = {
      id: 'workflow-run-1',
      name: workflow.name,
      data: {
        workflowName: workflow.name,
        runId: 'workflow-run-1',
        input: { email: 'user@example.com' },
      },
      opts: {},
      async updateData(nextData: Record<string, unknown>) {
        this.data = nextData;
      },
    };

    await expect(processor(job as never)).resolves.toEqual({
      'deliver-email-step': { delivered: true },
    });
    expect(events.map(event => event.name)).toEqual([
      'orchestration.workflow.started',
      'orchestration.step.completed',
      'orchestration.workflow.completed',
      'orchestration.workflow.hookError',
    ]);
    expect(events[3]?.payload).toMatchObject({
      runId: 'workflow-run-1',
      workflow: workflow.name,
      hook: 'onComplete',
      error: { message: 'hook exploded' },
    });
  });

  test('rejects invalid dynamic sleep durations before scheduling a sleep job', async () => {
    const queue = new FakeQueue();
    const workflow = defineWorkflow({
      name: 'invalid-sleep-bullmq-workflow',
      input: z.object({}),
      steps: [sleep('wait-step', () => Number.NaN)],
    });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map(),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    const job: {
      id: string;
      name: string;
      data: Record<string, unknown>;
      opts: Record<string, unknown>;
      updateData(nextData: Record<string, unknown>): Promise<void>;
    } = {
      id: 'workflow-run-2',
      name: workflow.name,
      data: {
        workflowName: workflow.name,
        runId: 'workflow-run-2',
        input: {},
      },
      opts: {},
      async updateData(nextData: Record<string, unknown>) {
        this.data = nextData;
      },
    };

    await expect(processor(job as never)).rejects.toThrow(
      `Sleep step 'wait-step' duration must be a non-negative finite number.`,
    );
    expect(queue.addCalls).toHaveLength(0);
  });
});
