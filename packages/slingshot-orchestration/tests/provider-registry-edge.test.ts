import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOrchestrationProviderRegistry } from '../src/provider/registry';
import { defineTask } from '../src/defineTask';
import { defineWorkflow } from '../src/defineWorkflow';

describe('createOrchestrationProviderRegistry', () => {
  const schema = z.object({ x: z.number() });

  test('creates empty registry', () => {
    const registry = createOrchestrationProviderRegistry();
    expect(registry.getTasks()).toEqual([]);
    expect(registry.getWorkflows()).toEqual([]);
  });

  test('registers and retrieves tasks', () => {
    const registry = createOrchestrationProviderRegistry();
    const task = defineTask({
      name: 'test-task',
      input: schema,
      output: schema,
      handler: async (input) => ({ x: input.x + 1 }),
    });
    registry.registerTask(task);
    expect(registry.getTasks()).toHaveLength(1);
    expect(registry.getTasks()[0].name).toBe('test-task');
  });

  test('registers and retrieves workflows', () => {
    const registry = createOrchestrationProviderRegistry();
    const wf = defineWorkflow({
      name: 'test-wf',
      input: schema,
      output: schema,
    }, (w) => {
      w.step('step1', async () => ({ x: 1 }));
    });
    registry.registerWorkflow(wf);
    expect(registry.getWorkflows()).toHaveLength(1);
    expect(registry.getWorkflows()[0].name).toBe('test-wf');
  });

  test('getTask returns undefined for missing task', () => {
    const registry = createOrchestrationProviderRegistry();
    expect(registry.getTask('nonexistent')).toBeUndefined();
  });

  test('getTask returns registered task', () => {
    const registry = createOrchestrationProviderRegistry();
    const task = defineTask({
      name: 'find-me',
      input: schema,
      output: schema,
      handler: async (input) => ({ x: input.x }),
    });
    registry.registerTask(task);
    expect(registry.getTask('find-me')).toBeDefined();
    expect(registry.getTask('find-me')!.name).toBe('find-me');
  });

  test('getWorkflow returns undefined for missing workflow', () => {
    const registry = createOrchestrationProviderRegistry();
    expect(registry.getWorkflow('nonexistent')).toBeUndefined();
  });

  test('getWorkflow returns registered workflow', () => {
    const registry = createOrchestrationProviderRegistry();
    const wf = defineWorkflow({
      name: 'find-wf',
      input: schema,
      output: schema,
    }, (w) => {
      w.step('s1', async () => ({ x: 0 }));
    });
    registry.registerWorkflow(wf);
    expect(registry.getWorkflow('find-wf')).toBeDefined();
    expect(registry.getWorkflow('find-wf')!.name).toBe('find-wf');
  });

  test('getManifest returns combined task and workflow definitions', () => {
    const registry = createOrchestrationProviderRegistry();
    const task = defineTask({
      name: 'manifest-task',
      input: schema,
      output: schema,
      handler: async (input) => ({ x: input.x }),
    });
    const wf = defineWorkflow({
      name: 'manifest-wf',
      input: schema,
      output: schema,
    }, (w) => {
      w.step('s1', async () => ({ x: 0 }));
    });
    registry.registerTask(task);
    registry.registerWorkflow(wf);

    const manifest = registry.getManifest();
    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.workflows).toHaveLength(1);
    expect(manifest.tasks[0].name).toBe('manifest-task');
    expect(manifest.workflows[0].name).toBe('manifest-wf');
  });
});
