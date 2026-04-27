import { describe, expect, it } from 'bun:test';
import { isrConfigSchema, ssrPluginConfigSchema } from '../../../src/config.schema';

describe('isrConfigSchema — backgroundRegenTimeoutMs', () => {
  it('accepts a positive integer timeout', () => {
    const result = isrConfigSchema.parse({ backgroundRegenTimeoutMs: 5000 });
    expect(result).toEqual({ backgroundRegenTimeoutMs: 5000 });
  });

  it('accepts backgroundRegenTimeoutMs alongside adapter', () => {
    const adapter = {
      get: async () => null,
      set: async () => {},
      invalidatePath: async () => {},
      invalidateTag: async () => {},
    };
    const result = isrConfigSchema.parse({ adapter, backgroundRegenTimeoutMs: 10_000 });
    expect(result?.backgroundRegenTimeoutMs).toBe(10_000);
  });

  it('rejects zero', () => {
    expect(() => isrConfigSchema.parse({ backgroundRegenTimeoutMs: 0 })).toThrow();
  });

  it('rejects a negative value', () => {
    expect(() => isrConfigSchema.parse({ backgroundRegenTimeoutMs: -1000 })).toThrow();
  });

  it('rejects a non-integer (float)', () => {
    expect(() => isrConfigSchema.parse({ backgroundRegenTimeoutMs: 5000.5 })).toThrow();
  });

  it('allows omitting backgroundRegenTimeoutMs', () => {
    const result = isrConfigSchema.parse({});
    expect(result?.backgroundRegenTimeoutMs).toBeUndefined();
  });
});

describe('ssrPluginConfigSchema — isr.backgroundRegenTimeoutMs passes through', () => {
  it('accepts isr with backgroundRegenTimeoutMs set', () => {
    const result = ssrPluginConfigSchema.parse({
      renderer: { resolve: () => {}, render: () => {} },
      serverRoutesDir: '/abs/path',
      assetsManifest: 'manifest.json',
      isr: { backgroundRegenTimeoutMs: 5000 },
    });
    expect(result.isr?.backgroundRegenTimeoutMs).toBe(5000);
  });
});
