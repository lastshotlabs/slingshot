import { describe, expect, test } from 'bun:test';
import { orchestrationPluginConfigSchema } from '../src/validation';

describe('Plugin startup validation', () => {
  test('memory adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      tasks: ['taskA'],
    });
    expect(result.success).toBe(true);
  });

  test('sqlite adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'sqlite', config: { path: ':memory:' } },
      tasks: ['taskA'],
    });
    expect(result.success).toBe(true);
  });

  test('bullmq adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'bullmq', config: { connection: { host: 'localhost', port: 6379 } } },
      tasks: ['taskA'],
    });
    expect(result.success).toBe(true);
  });

  test('temporal adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: {
        type: 'temporal',
        config: { address: 'localhost:7233', workflowTaskQueue: 'workflow-tasks' },
      },
      tasks: ['taskA'],
    });
    expect(result.success).toBe(true);
  });

  test('missing adapter is rejected', () => {
    const result = orchestrationPluginConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('route timeout is validated', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      tasks: ['taskA'],
      routeTimeoutMs: 60000,
    });
    expect(result.success).toBe(true);
  });

  test('negative route timeout is rejected', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      tasks: ['taskA'],
      routeTimeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  test('route prefix is validated', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      tasks: ['taskA'],
      routePrefix: '/tasks',
    });
    expect(result.success).toBe(true);
  });
});
