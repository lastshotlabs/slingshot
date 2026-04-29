import { describe, expect, test } from 'bun:test';
import { orchestrationPluginConfigSchema } from '../src/validation';

describe('orchestrationPluginConfigSchema', () => {
  test('accepts minimal valid config', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing adapter', () => {
    const result = orchestrationPluginConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects invalid adapter type', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  test('accepts bullmq adapter type', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'bullmq', connection: { host: 'localhost', port: 6379 } },
    });
    expect(result.success).toBe(true);
  });

  test('accepts temporal adapter type', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'temporal', connection: { address: 'localhost:7233' } },
    });
    expect(result.success).toBe(true);
  });

  test('accepts route timeout config', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      routeTimeoutMs: 60000,
    });
    expect(result.success).toBe(true);
  });

  test('accepts mount path', () => {
    const result = orchestrationPluginConfigSchema.safeParse({
      adapter: { type: 'memory' },
      mountPath: '/orchestration',
    });
    expect(result.success).toBe(true);
  });
});
