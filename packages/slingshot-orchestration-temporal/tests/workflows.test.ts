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
});
