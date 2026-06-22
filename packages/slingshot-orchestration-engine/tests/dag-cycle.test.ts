import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, parallel, step } from '../src/defineWorkflow';
import { OrchestrationError } from '../src/errors';

describe('orchestration workflow DAG validation', () => {
  const task = defineTask({
    name: 'noop-task',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    async handler() {
      return { ok: true };
    },
  });

  test('rejects 3-node cycle a -> b -> c -> a with INVALID_WORKFLOW', () => {
    expect(() =>
      defineWorkflow({
        name: 'cyclic-workflow',
        input: z.object({}),
        steps: [
          step('a', task, { dependsOn: ['c'] }),
          step('b', task, { dependsOn: ['a'] }),
          step('c', task, { dependsOn: ['b'] }),
        ],
      }),
    ).toThrow(OrchestrationError);

    try {
      defineWorkflow({
        name: 'cyclic-workflow',
        input: z.object({}),
        steps: [
          step('a', task, { dependsOn: ['c'] }),
          step('b', task, { dependsOn: ['a'] }),
          step('c', task, { dependsOn: ['b'] }),
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      const orchError = error as OrchestrationError;
      expect(orchError.code).toBe('INVALID_WORKFLOW');
      expect(orchError.message).toMatch(/dependency cycle/);
      // Cycle nodes should be listed in order.
      expect(orchError.message).toMatch(/a/);
      expect(orchError.message).toMatch(/b/);
      expect(orchError.message).toMatch(/c/);
    }
  });

  test('rejects self-dependency with INVALID_WORKFLOW', () => {
    expect(() =>
      defineWorkflow({
        name: 'self-cycle',
        input: z.object({}),
        steps: [step('only', task, { dependsOn: ['only'] })],
      }),
    ).toThrow(/depends on itself/);
  });

  test('rejects dependency on unknown step with INVALID_WORKFLOW', () => {
    expect(() =>
      defineWorkflow({
        name: 'dangling-dep',
        input: z.object({}),
        steps: [step('only', task, { dependsOn: ['ghost'] })],
      }),
    ).toThrow(/depends on unknown step 'ghost'/);
  });

  test('rejects cycle that crosses parallel groups', () => {
    expect(() =>
      defineWorkflow({
        name: 'parallel-cycle',
        input: z.object({}),
        steps: [
          parallel([step('a', task, { dependsOn: ['b'] }), step('b', task, { dependsOn: ['a'] })]),
        ],
      }),
    ).toThrow(/dependency cycle/);
  });

  test('accepts DAG with no cycles', () => {
    const workflow = defineWorkflow({
      name: 'valid-dag',
      input: z.object({}),
      steps: [
        step('a', task),
        step('b', task, { dependsOn: ['a'] }),
        step('c', task, { dependsOn: ['a', 'b'] }),
      ],
    });
    expect(workflow.name).toBe('valid-dag');
  });

  test('validates dependsOn entries are strings', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      step('bad', task, { dependsOn: [42] }),
    ).toThrow(/non-empty strings/);
  });
});
