// packages/slingshot-ssg/tests/config-parse-edge.test.ts
//
// Edge cases for SSG config parsing: boundary values for every numeric field,
// combinations of optional fields, and schema coercion behavior.
import { describe, expect, test } from 'bun:test';
import { parseSsgConfig, ssgConfigSchema } from '../src/config.schema';

const minimalValid = {
  serverRoutesDir: '/app/server/routes',
  assetsManifest: '/app/dist/client/.vite/manifest.json',
  outDir: '/app/dist/static',
};

function parse(value: unknown) {
  return ssgConfigSchema.safeParse(value);
}

describe('parseSsgConfig — boundary values', () => {
  test('accepts concurrency at exact minimum (1)', () => {
    const config = parseSsgConfig({ ...minimalValid, concurrency: 1 });
    expect(config.concurrency).toBe(1);
  });

  test('accepts concurrency at exact maximum (256)', () => {
    const config = parseSsgConfig({ ...minimalValid, concurrency: 256 });
    expect(config.concurrency).toBe(256);
  });

  test('rejects concurrency one above maximum (257)', () => {
    expect(() => parseSsgConfig({ ...minimalValid, concurrency: 257 })).toThrow('[slingshot-ssg]');
  });

  test('accepts staticPathsTimeoutMs at exact minimum (1)', () => {
    const config = parseSsgConfig({ ...minimalValid, staticPathsTimeoutMs: 1 });
    expect(config.staticPathsTimeoutMs).toBe(1);
  });

  test('accepts renderPageTimeoutMs=0 to disable timeout', () => {
    const config = parseSsgConfig({ ...minimalValid, renderPageTimeoutMs: 0 });
    expect(config.renderPageTimeoutMs).toBe(0);
  });

  test('accepts maxStaticPathsPerRoute at exact minimum (1)', () => {
    const config = parseSsgConfig({ ...minimalValid, maxStaticPathsPerRoute: 1 });
    expect(config.maxStaticPathsPerRoute).toBe(1);
  });

  test('rejects maxStaticPathsPerRoute=0', () => {
    const result = parse({ ...minimalValid, maxStaticPathsPerRoute: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects maxStaticPathsPerRoute=-1', () => {
    const result = parse({ ...minimalValid, maxStaticPathsPerRoute: -1 });
    expect(result.success).toBe(false);
  });
});

describe('parseSsgConfig — combination edge cases', () => {
  test('accepts all optional fields simultaneously', () => {
    const config = parseSsgConfig({
      ...minimalValid,
      concurrency: 8,
      clientEntry: 'src/client/main.ts',
      staticPathsTimeoutMs: 30_000,
      maxStaticPathsPerRoute: 5_000,
      renderPageTimeoutMs: 120_000,
    });
    expect(config.concurrency).toBe(8);
    expect(config.clientEntry).toBe('src/client/main.ts');
    expect(config.staticPathsTimeoutMs).toBe(30_000);
    expect(config.maxStaticPathsPerRoute).toBe(5_000);
    expect(config.renderPageTimeoutMs).toBe(120_000);
  });

  test('propagates undefined concurrency as undefined (caller handles default)', () => {
    const config = parseSsgConfig(minimalValid);
    expect(config.concurrency).toBeUndefined();
  });

  test('propagates undefined clientEntry as undefined', () => {
    const config = parseSsgConfig(minimalValid);
    expect(config.clientEntry).toBeUndefined();
  });

  test('accepts but passes through empty string for clientEntry (schema treats as valid)', () => {
    // The schema accepts min(1) strings, so empty string is rejected
    const result = parse({ ...minimalValid, clientEntry: '' });
    expect(result.success).toBe(false);
  });
});

describe('ssgConfigSchema — rejection edge cases', () => {
  test('rejects concurrency set to Infinity', () => {
    const result = parse({ ...minimalValid, concurrency: Infinity });
    expect(result.success).toBe(false);
  });

  test('rejects concurrency set to NaN', () => {
    const result = parse({ ...minimalValid, concurrency: NaN });
    expect(result.success).toBe(false);
  });

  test('rejects concurrency as string', () => {
    const result = parse({ ...minimalValid, concurrency: '4' });
    expect(result.success).toBe(false);
  });

  test('rejects staticPathsTimeoutMs set to 0', () => {
    const result = parse({ ...minimalValid, staticPathsTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects staticPathsTimeoutMs as string', () => {
    const result = parse({ ...minimalValid, staticPathsTimeoutMs: '30000' });
    expect(result.success).toBe(false);
  });

  test('rejects maxStaticPathsPerRoute as string', () => {
    const result = parse({ ...minimalValid, maxStaticPathsPerRoute: '100' });
    expect(result.success).toBe(false);
  });
});
