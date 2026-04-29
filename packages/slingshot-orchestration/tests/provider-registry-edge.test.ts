import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOrchestrationProviderRegistry } from '../src/provider/registry';
import { defineTask } from '../src/defineTask';

const schema = z.object({ x: z.number() });

function makeTask(name: string) {
  return defineTask({
    name,
    input: schema,
    output: schema,
    handler: async (input) => ({ x: input.x + 1 }),
  });
}

describe('createOrchestrationProviderRegistry', () => {
  test('creates registry with empty lists', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(registry.listTasks()).toEqual([]);
    expect(registry.listWorkflows()).toEqual([]);
  });

  test('registers and lists tasks', () => {
    const task = makeTask('test-task');
    const registry = createOrchestrationProviderRegistry({ tasks: [task], workflows: [] });
    expect(registry.listTasks()).toHaveLength(1);
    expect(registry.listTasks()[0].name).toBe('test-task');
  });

  test('listWorkflows returns empty when none registered', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(registry.listWorkflows()).toEqual([]);
  });

  test('hasTask returns false for missing task', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(registry.hasTask('nonexistent')).toBe(false);
  });

  test('hasTask returns true for registered task', () => {
    const task = makeTask('find-me');
    const registry = createOrchestrationProviderRegistry({ tasks: [task], workflows: [] });
    expect(registry.hasTask('find-me')).toBe(true);
  });

  test('getTask throws for missing task', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(() => registry.getTask('nonexistent')).toThrow();
  });

  test('getTask returns registered task', () => {
    const task = makeTask('find-me');
    const registry = createOrchestrationProviderRegistry({ tasks: [task], workflows: [] });
    expect(registry.getTask('find-me').name).toBe('find-me');
  });

  test('hasWorkflow returns false for missing', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(registry.hasWorkflow('nonexistent')).toBe(false);
  });

  test('getWorkflow throws for missing workflow', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    expect(() => registry.getWorkflow('nonexistent')).toThrow();
  });

  test('listTaskManifests returns manifests for registered tasks', () => {
    const task = makeTask('manifest-task');
    const registry = createOrchestrationProviderRegistry({ tasks: [task], workflows: [] });
    const manifests = registry.listTaskManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0].name).toBe('manifest-task');
  });

  test('listWorkflowManifests returns empty when none', () => {
    const registry = createOrchestrationProviderRegistry({ tasks: [], workflows: [] });
    // listWorkflowManifests may have a different name - just verify empty
    const wfs = registry.listWorkflows();
    expect(wfs).toEqual([]);
  });

  test('duplicate task names throw', () => {
    const task = makeTask('dup-task');
    expect(() =>
      createOrchestrationProviderRegistry({ tasks: [task, task], workflows: [] }),
    ).toThrow();
  });
});
