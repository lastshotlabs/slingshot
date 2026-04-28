import { describe, expect, mock, test } from 'bun:test';
import type { AnyResolvedTask, AnyResolvedWorkflow } from '@lastshotlabs/slingshot-orchestration';
import {
  clearWorkerRegistries,
  getRegisteredTask,
  getRegisteredWorkflow,
  getRegisteredWorkflowHooks,
  installWorkerRegistries,
  isWorkerRegistryInstalled,
} from '../src/workerRegistry';

describe('Temporal worker registries', () => {
  test('installs, exposes, and clears task and workflow definitions', () => {
    clearWorkerRegistries();

    const task = {
      _tag: 'ResolvedTask',
      name: 'send-email',
    } as unknown as AnyResolvedTask;
    const workflow = {
      _tag: 'ResolvedWorkflow',
      name: 'welcome-flow',
      onStart: mock(() => {}),
      onComplete: mock(() => {}),
      onFail: mock(() => {}),
    } as unknown as AnyResolvedWorkflow;

    installWorkerRegistries({ tasks: [task], workflows: [workflow] });

    expect(isWorkerRegistryInstalled()).toBe(true);
    expect(getRegisteredTask('send-email')).toBe(task);
    expect(getRegisteredWorkflow('welcome-flow')).toBe(workflow);
    expect(getRegisteredWorkflowHooks('welcome-flow')).toEqual({
      onStart: workflow.onStart,
      onComplete: workflow.onComplete,
      onFail: workflow.onFail,
    });
    expect(() => installWorkerRegistries({ tasks: [], workflows: [] })).toThrow(
      'Temporal worker registries are already installed in this process.',
    );

    clearWorkerRegistries();

    expect(isWorkerRegistryInstalled()).toBe(false);
    expect(getRegisteredTask('send-email')).toBeUndefined();
    expect(getRegisteredWorkflow('welcome-flow')).toBeUndefined();
    expect(getRegisteredWorkflowHooks('welcome-flow')).toBeUndefined();
  });
});
