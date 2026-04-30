import { describe, expect, test } from 'bun:test';
import { slingshotTaskWorkflowImpl, slingshotWorkflowImpl } from '../src/workflows';

describe('Temporal workflow implementations', () => {
  test('rejects unregistered task workflows before scheduling activities', async () => {
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: 'missing-task',
          input: null,
          runId: 'run-1',
        },
      ),
    ).rejects.toThrow("Task 'missing-task' is not registered.");
  });

  test('rejects unregistered workflows before scheduling activities', async () => {
    await expect(
      slingshotWorkflowImpl(
        {},
        {
          workflowName: 'missing-workflow',
          input: null,
          runId: 'run-1',
        },
      ),
    ).rejects.toThrow("Workflow 'missing-workflow' is not registered.");
  });

  test('rejects tasks with empty name in task workflow', async () => {
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: '',
          input: null,
          runId: 'run-2',
        },
      ),
    ).rejects.toThrow("Task '' is not registered.");
  });

  test('rejects workflows with empty name in workflow impl', async () => {
    await expect(
      slingshotWorkflowImpl(
        {},
        {
          workflowName: '',
          input: null,
          runId: 'run-3',
        },
      ),
    ).rejects.toThrow("Workflow '' is not registered.");
  });

  test('rejects task workflow when taskManifestMap is null', async () => {
    // Simulate a null/empty manifest map
    await expect(
      slingshotTaskWorkflowImpl(null as unknown as Record<string, unknown>, {
        taskName: 'some-task',
        input: null,
        runId: 'run-4',
      }),
    ).rejects.toThrow("Task 'some-task' is not registered.");
  });

  test('rejects workflow when manifest map is empty', async () => {
    await expect(
      slingshotWorkflowImpl(
        {},
        {
          workflowName: 'any-workflow',
          input: null,
          runId: 'run-5',
        },
      ),
    ).rejects.toThrow("Workflow 'any-workflow' is not registered.");
  });

  test('rejects task with null runId', async () => {
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: 'missing',
          input: null,
          runId: null as unknown as string,
        },
      ),
    ).rejects.toThrow("Task 'missing' is not registered.");
  });

  test('rejects workflow with undefined runId', async () => {
    await expect(
      slingshotWorkflowImpl(
        {},
        {
          workflowName: 'missing',
          input: null,
          runId: undefined as unknown as string,
        },
      ),
    ).rejects.toThrow("Workflow 'missing' is not registered.");
  });

  test('rejects task with complex nested null input', async () => {
    // null input should be handled gracefully
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: 'null-input-task',
          input: { nested: null, values: [1, null, 3] },
          runId: 'run-null-input',
        },
      ),
    ).rejects.toThrow("Task 'null-input-task' is not registered.");
  });

  test('rejects task workflow with undefined manifest', async () => {
    await expect(
      slingshotTaskWorkflowImpl(undefined as unknown as Record<string, unknown>, {
        taskName: 'any',
        input: {},
        runId: 'run-6',
      }),
    ).rejects.toThrow("Task 'any' is not registered.");
  });

  test('slingshotTaskWorkflowImpl throws ApplicationFailure for unregistered task', async () => {
    // Verify the error is thrown with a meaningful message
    let thrown: unknown;
    try {
      await slingshotTaskWorkflowImpl(
        {},
        {
          taskName: 'unknown-task',
          input: {},
          runId: 'run-7',
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain("Task 'unknown-task' is not registered.");
  });

  test('slingshotWorkflowImpl throws ApplicationFailure for unregistered workflow', async () => {
    let thrown: unknown;
    try {
      await slingshotWorkflowImpl(
        {},
        {
          workflowName: 'unknown-wf',
          input: { data: 1 },
          runId: 'run-8',
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain("Workflow 'unknown-wf' is not registered.");
  });

  test('rejects task with special characters in name', async () => {
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: 'special-chars!@#$%^&*()',
          input: null,
          runId: 'run-special',
        },
      ),
    ).rejects.toThrow("Task 'special-chars!@#$%^&*()' is not registered.");
  });

  test('rejects task with extremely long name', async () => {
    const longName = 'a'.repeat(500);
    await expect(
      slingshotTaskWorkflowImpl(
        {},
        {
          taskName: longName,
          input: null,
          runId: 'run-long',
        },
      ),
    ).rejects.toThrow(`Task '${longName}' is not registered.`);
  });
});
