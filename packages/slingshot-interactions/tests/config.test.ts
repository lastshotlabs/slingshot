import { describe, expect, test } from 'bun:test';
import { interactionsPluginConfigSchema } from '../src/config/schema';

describe('interactionsPluginConfigSchema', () => {
  test('rejects mountPath values that do not start with a slash', () => {
    const result = interactionsPluginConfigSchema.safeParse({
      mountPath: 'interactions',
    });

    expect(result.success).toBe(false);
  });

  test('accepts the default mountPath shape', () => {
    const result = interactionsPluginConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mountPath).toBe('/interactions');
    }
  });
});
