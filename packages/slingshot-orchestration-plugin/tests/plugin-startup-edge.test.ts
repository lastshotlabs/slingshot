import { describe, expect, test } from 'bun:test';
import { orchestrationPluginConfigSchema } from '../src/validation';

describe('Plugin startup validation', () => {
  test('memory adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
    });
    expect(result.success).toBe(true);
  });

  test('sqlite adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'sqlite', path: ':memory:' },
    });
    expect(result.success).toBe(true);
  });

  test('bullmq adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'bullmq', connection: { host: 'localhost', port: 6379 } },
    });
    expect(result.success).toBe(true);
  });

  test('temporal adapter config is valid', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'temporal', connection: { address: 'localhost:7233' } },
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
      routeTimeoutMs: 60000,
    });
    expect(result.success).toBe(true);
  });

  test('negative route timeout is rejected', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      routeTimeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  test('mount path is validated', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      mountPath: '/tasks',
    });
    expect(result.success).toBe(true);
  });
});
