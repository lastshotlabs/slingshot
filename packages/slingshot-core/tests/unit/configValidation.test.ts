import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  disableRoutesSchema,
  validateAdapterShape,
  validatePluginConfig,
  warnUnknownPluginKeys,
} from '../../src/configValidation';

describe('disableRoutesSchema', () => {
  test('creates an optional array schema of route enums', () => {
    const schema = disableRoutesSchema(['GET /items', 'POST /items']);
    const result = schema.parse(['GET /items']);
    expect(result).toEqual(['GET /items']);
  });

  test('returns undefined when omitted', () => {
    const schema = disableRoutesSchema(['GET /items']);
    const result = schema.parse(undefined);
    expect(result).toBeUndefined();
  });
});

describe('warnUnknownPluginKeys', () => {
  test('warns for unknown keys', () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const schema = z.object({ maxRetries: z.number() });
    warnUnknownPluginKeys('test-plugin', { maxRetries: 3, maxRtries: 5 }, schema as never);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls as unknown[][])[0]?.[0]).toContain('maxRtries');
    console.warn = originalWarn;
  });

  test('does not warn for known keys', () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const schema = z.object({ maxRetries: z.number() });
    warnUnknownPluginKeys('test-plugin', { maxRetries: 3 }, schema as never);

    expect(warnSpy).not.toHaveBeenCalled();
    console.warn = originalWarn;
  });
});

describe('validateAdapterShape', () => {
  test('passes when all methods present', () => {
    const adapter = { createGrant: () => {}, revokeGrant: () => {} };
    expect(() =>
      validateAdapterShape('perms', 'adapter', adapter, ['createGrant', 'revokeGrant']),
    ).not.toThrow();
  });

  test('throws when methods are missing', () => {
    const adapter = { createGrant: () => {} };
    expect(() =>
      validateAdapterShape('perms', 'adapter', adapter, ['createGrant', 'revokeGrant']),
    ).toThrow('missing required methods: revokeGrant');
  });

  test('throws when adapter is null', () => {
    expect(() => validateAdapterShape('perms', 'adapter', null, ['createGrant'])).toThrow(
      'missing required methods',
    );
  });

  test('throws when property is not a function', () => {
    const adapter = { createGrant: 'not-a-function' };
    expect(() => validateAdapterShape('perms', 'adapter', adapter, ['createGrant'])).toThrow(
      'missing required methods: createGrant',
    );
  });
});

describe('validatePluginConfig', () => {
  test('returns parsed config on success', () => {
    const schema = z.object({ maxRetries: z.number().default(3) });
    const result = validatePluginConfig('test', {}, schema as never);
    expect((result as { maxRetries: number }).maxRetries).toBe(3);
  });

  test('throws on validation failure', () => {
    const schema = z.object({ maxRetries: z.number() });
    expect(() => validatePluginConfig('test', { maxRetries: 'bad' }, schema as never)).toThrow(
      'Invalid plugin config',
    );
  });

  test('warns about unknown keys for object configs', () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const schema = z.object({ maxRetries: z.number().default(3) });
    validatePluginConfig('test', { maxRetries: 5, typo: true }, schema as never);

    expect(warnSpy).toHaveBeenCalled();
    console.warn = originalWarn;
  });

  test('skips unknown key check for non-object rawConfig', () => {
    // null rawConfig shouldn't error in the unknown-key path
    const schema = z.object({ val: z.number().default(1) }).optional();
    // safeParse of undefined will use default so this passes
    const result = validatePluginConfig('test', undefined, schema as never);
    expect(result).toBeUndefined();
  });
});
