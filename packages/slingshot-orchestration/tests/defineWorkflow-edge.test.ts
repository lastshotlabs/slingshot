// packages/slingshot-orchestration/tests/defineWorkflow-edge.test.ts
//
// Edge cases for workflow definition: output schemas, outputMapper, step
// conditions, dynamic sleep durations, nested parallel, and stepResult.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import {
  defineWorkflow,
  parallel,
  sleep,
  step,
  stepResult,
} from '../src/defineWorkflow';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler() {
    return { ok: true };
  },
});

const echoTask = defineTask({
  name: 'echo-task',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async handler(input) {
    return { echoed: input.value };
  },
});

describe('defineWorkflow — output and outputMapper', () => {
  test('accepts output schema', () => {
    const workflow = defineWorkflow({
      name: 'wf-with-output',
      input: z.object({}),
      output: z.object({ result: z.string() }),
      steps: [step('s1', noopTask)],
    });
    expect(workflow.output).toBeDefined();
    expect(workflow._tag).toBe('ResolvedWorkflow');
  });

  test('accepts outputMapper function', () => {
    const workflow = defineWorkflow({
      name: 'wf-with-mapper',
      input: z.object({}),
      output: z.object({ allOk: z.boolean() }),
      steps: [step('s1', noopTask)],
      outputMapper(results) {
        return { allOk: results['s1']?.ok === true };
      },
    });
    expect(typeof workflow.outputMapper).toBe('function');
  });

  test('outputMapper transforms step results at runtime', async () => {
    const workflow = defineWorkflow({
      name: 'mapper-test',
      input: z.object({}),
      output: z.object({ allOk: z.boolean() }),
      steps: [step('s1', noopTask)],
      outputMapper(results) {
        const s1 = results['s1'] as { ok: boolean } | undefined;
        return { allOk: s1?.ok === true };
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
      workflows: [workflow],
    });

    const handle = await runtime.runWorkflow(workflow, {});
    const result = await handle.result();
    expect(result).toEqual({ allOk: true });
  });
});

describe('defineWorkflow — step condition', () => {
  test('step with condition function is accepted', () => {
    const workflow = defineWorkflow({
      name: 'conditional-wf',
      input: z.object({ skip: z.boolean() }),
      steps: [
        step('s1', noopTask, {
          condition: (ctx) => !ctx.workflowInput.skip,
        }),
      ],
    });
    const stepEntry = workflow.steps[0];
    expect(stepEntry._tag).toBe('Step');
    if (stepEntry._tag === 'Step') {
      expect(typeof stepEntry.options.condition).toBe('function');
    }
  });

  test('step without condition has undefined condition', () => {
    const workflow = defineWorkflow({
      name: 'no-condition-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
    });
    const stepEntry = workflow.steps[0];
    if (stepEntry._tag === 'Step') {
      expect(stepEntry.options.condition).toBeUndefined();
    }
  });
});

describe('defineWorkflow — sleep edge cases', () => {
  test('sleep with positive dynamic duration is accepted', () => {
    const entry = sleep('dynamic-sleep', () => 500);
    expect(entry._tag).toBe('Sleep');
    expect(entry.name).toBe('dynamic-sleep');
    expect(typeof entry.duration).toBe('function');
  });

  test('sleep with zero duration is accepted', () => {
    const entry = sleep('zero-sleep', 0);
    expect(entry.duration).toBe(0);
  });

  test('sleep with negative number throws', () => {
    expect(() => sleep('bad-sleep', -1)).toThrow(OrchestrationError);
  });

  test('sleep with NaN duration throws', () => {
    expect(() => sleep('nan-sleep', NaN)).toThrow(OrchestrationError);
  });

  test('sleep with Infinity duration throws', () => {
    expect(() => sleep('inf-sleep', Infinity)).toThrow(OrchestrationError);
  });
});

describe('defineWorkflow — stepResult', () => {
  test('stepResult returns undefined for missing step', () => {
    const result = stepResult({}, 'nonexistent');
    expect(result).toBeUndefined();
  });

  test('stepResult returns the step value when present', () => {
    const result = stepResult({ 'step-a': { value: 42 } }, 'step-a');
    expect(result).toEqual({ value: 42 });
  });

  test('stepResult with typed generic narrows the result', () => {
    interface MyResult { value: number }
    const result = stepResult<MyResult>({ 'calc': { value: 42 } }, 'calc');
    expect(result?.value).toBe(42);
  });
});

describe('defineWorkflow — validation edge cases', () => {
  test('rejects workflow with no steps', () => {
    expect(() =>
      defineWorkflow({
        name: 'empty-wf',
        input: z.object({}),
        steps: [],
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects workflow with non-kebab name', () => {
    expect(() =>
      defineWorkflow({
        name: 'BadWorkflowName',
        input: z.object({}),
        steps: [step('s1', noopTask)],
      }),
    ).toThrow(OrchestrationError);
  });

  test('accepts workflow with description', () => {
    const workflow = defineWorkflow({
      name: 'described-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
      description: 'A test workflow',
    });
    expect(workflow.description).toBe('A test workflow');
  });

  test('accepts valid timeout on workflow', () => {
    const workflow = defineWorkflow({
      name: 'timed-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
      timeout: 30_000,
    });
    expect(workflow.timeout).toBe(30_000);
  });

  test('rejects zero timeout', () => {
    expect(() =>
      defineWorkflow({
        name: 'zero-timeout-wf',
        input: z.object({}),
        steps: [step('s1', noopTask)],
        timeout: 0,
      }),
    ).toThrow(OrchestrationError);
  });

  test('rejects negative timeout', () => {
    expect(() =>
      defineWorkflow({
        name: 'neg-timeout-wf',
        input: z.object({}),
        steps: [step('s1', noopTask)],
        timeout: -1,
      }),
    ).toThrow(OrchestrationError);
  });
});

describe('defineWorkflow — step timeout validation', () => {
  test('step with valid timeout is accepted', () => {
    const wf = defineWorkflow({
      name: 'valid-step-timeout',
      input: z.object({}),
      steps: [step('s1', noopTask, { timeout: 5000 })],
    });
    const entry = wf.steps[0];
    if (entry._tag === 'Step') {
      expect(entry.options.timeout).toBe(5000);
    }
  });

  test('step with zero timeout throws', () => {
    expect(() => step('bad-timeout', noopTask, { timeout: 0 })).toThrow(OrchestrationError);
  });

  test('step with negative timeout throws', () => {
    expect(() => step('neg-timeout', noopTask, { timeout: -1 })).toThrow(OrchestrationError);
  });
});

describe('defineWorkflow — step condition rejects invalid', () => {
  test('step condition expects a function', () => {
    // Condition must be a function when provided; passing a non-function
    // would be a TS error but the step() function itself does not validate
    // the type of condition beyond storing it. The runtime ignores
    // non-function conditions.
    const wf = defineWorkflow({
      name: 'bad-condition-wf',
      input: z.object({}),
      steps: [
        // @ts-expect-error - testing non-function condition silently ignored
        step('s1', noopTask, { condition: 'not-a-function' }),
      ],
    });
    const entry = wf.steps[0];
    if (entry._tag === 'Step') {
      // Non-function conditions are stored but treated as absent at runtime
      expect(typeof entry.options.condition).toBe('string');
    }
  });
});

describe('defineWorkflow — onStart/onComplete/onFail hooks', () => {
  test('onStart as function is accepted', () => {
    const wf = defineWorkflow({
      name: 'onstart-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
      onStart() {},
    });
    expect(typeof wf.onStart).toBe('function');
  });

  test('onStart as object with handler is accepted', () => {
    const wf = defineWorkflow({
      name: 'onstart-obj-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
      onStart: {
        handler() {},
        continueOnHookError: false,
      },
    });
    expect(wf.onStart).toBeDefined();
  });

  test('onComplete and onFail are accepted', () => {
    const wf = defineWorkflow({
      name: 'hooks-wf',
      input: z.object({}),
      steps: [step('s1', noopTask)],
      onComplete() {},
      onFail() {},
    });
    expect(typeof wf.onComplete).toBe('function');
    expect(typeof wf.onFail).toBe('function');
  });
});
