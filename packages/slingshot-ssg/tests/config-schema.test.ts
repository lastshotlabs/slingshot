// packages/slingshot-ssg/tests/config-schema.test.ts
import { describe, expect, test } from 'bun:test';
import { parseSsgConfig, ssgConfigSchema } from '../src/config.schema';

function parse(value: unknown) {
  return ssgConfigSchema.safeParse(value);
}

function valid(value: unknown) {
  const result = parse(value);
  expect(result.success).toBe(true);
  return result.success ? result.data : null;
}

function invalid(value: unknown) {
  const result = parse(value);
  expect(result.success).toBe(false);
  return result.success ? null : result.error;
}

const minimalValid = {
  serverRoutesDir: '/app/server/routes',
  assetsManifest: '/app/dist/client/.vite/manifest.json',
  outDir: '/app/dist/static',
};

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe('ssgConfigSchema — valid configs', () => {
  test('accepts minimal config with required fields only', () => {
    const data = valid(minimalValid);
    expect(data?.serverRoutesDir).toBe('/app/server/routes');
    expect(data?.assetsManifest).toBe('/app/dist/client/.vite/manifest.json');
    expect(data?.outDir).toBe('/app/dist/static');
    expect(data?.concurrency).toBeUndefined();
    expect(data?.clientEntry).toBeUndefined();
  });

  test('accepts full config with all optional fields', () => {
    const data = valid({
      ...minimalValid,
      concurrency: 8,
      clientEntry: 'src/client/main.ts',
    });
    expect(data?.concurrency).toBe(8);
    expect(data?.clientEntry).toBe('src/client/main.ts');
  });

  test('accepts concurrency of 1', () => {
    const data = valid({ ...minimalValid, concurrency: 1 });
    expect(data?.concurrency).toBe(1);
  });

  test('strips unknown fields', () => {
    const data = valid({ ...minimalValid, unknownField: true, anotherExtra: 'oops' });
    expect(data).not.toBeNull();
    expect((data as Record<string, unknown>)['unknownField']).toBeUndefined();
    expect((data as Record<string, unknown>)['anotherExtra']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Absolute path enforcement
// ---------------------------------------------------------------------------

describe('ssgConfigSchema — absolute path enforcement', () => {
  test('rejects relative serverRoutesDir', () => {
    const err = invalid({ ...minimalValid, serverRoutesDir: 'server/routes' });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('serverRoutesDir'))).toBe(true);
  });

  test('rejects relative assetsManifest', () => {
    const err = invalid({ ...minimalValid, assetsManifest: 'dist/client/.vite/manifest.json' });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('assetsManifest'))).toBe(true);
  });

  test('rejects relative outDir', () => {
    const err = invalid({ ...minimalValid, outDir: 'dist/static' });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('outDir'))).toBe(true);
  });

  test('rejects empty serverRoutesDir', () => {
    const err = invalid({ ...minimalValid, serverRoutesDir: '' });
    expect(err).toBeDefined();
  });

  test('rejects empty outDir', () => {
    const err = invalid({ ...minimalValid, outDir: '' });
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// concurrency validation
// ---------------------------------------------------------------------------

describe('ssgConfigSchema — concurrency validation', () => {
  test('rejects concurrency of 0', () => {
    const err = invalid({ ...minimalValid, concurrency: 0 });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('concurrency'))).toBe(true);
  });

  test('rejects negative concurrency', () => {
    const err = invalid({ ...minimalValid, concurrency: -1 });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('concurrency'))).toBe(true);
  });

  test('rejects fractional concurrency', () => {
    const err = invalid({ ...minimalValid, concurrency: 1.5 });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('concurrency'))).toBe(true);
  });

  test('rejects non-numeric concurrency', () => {
    const err = invalid({ ...minimalValid, concurrency: 'four' });
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('ssgConfigSchema — required fields', () => {
  test('rejects missing serverRoutesDir', () => {
    const { serverRoutesDir: _, ...rest } = minimalValid;
    const err = invalid(rest);
    expect(err).toBeDefined();
  });

  test('rejects missing assetsManifest', () => {
    const { assetsManifest: _, ...rest } = minimalValid;
    const err = invalid(rest);
    expect(err).toBeDefined();
  });

  test('rejects missing outDir', () => {
    const { outDir: _, ...rest } = minimalValid;
    const err = invalid(rest);
    expect(err).toBeDefined();
  });

  test('rejects null input', () => {
    const err = invalid(null);
    expect(err).toBeDefined();
  });

  test('rejects non-object input', () => {
    const err = invalid('not an object');
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parseSsgConfig
// ---------------------------------------------------------------------------

describe('parseSsgConfig', () => {
  test('returns typed config for valid input', () => {
    const config = parseSsgConfig(minimalValid);
    expect(config.serverRoutesDir).toBe('/app/server/routes');
    expect(config.outDir).toBe('/app/dist/static');
  });

  test('throws a formatted error for relative outDir', () => {
    expect(() => parseSsgConfig({ ...minimalValid, outDir: 'dist/static' })).toThrow(
      '[slingshot-ssg]',
    );
  });

  test('throws for zero concurrency', () => {
    expect(() => parseSsgConfig({ ...minimalValid, concurrency: 0 })).toThrow('[slingshot-ssg]');
  });
});

// ---------------------------------------------------------------------------
// staticPathsTimeoutMs validation
// ---------------------------------------------------------------------------

describe('ssgConfigSchema — staticPathsTimeoutMs', () => {
  test('accepts valid positive integer timeout', () => {
    const data = valid({ ...minimalValid, staticPathsTimeoutMs: 30_000 });
    expect(data?.staticPathsTimeoutMs).toBe(30_000);
  });

  test('accepts omitted timeout (uses default)', () => {
    const data = valid(minimalValid);
    expect(data?.staticPathsTimeoutMs).toBeUndefined();
  });

  test('rejects zero timeout', () => {
    const err = invalid({ ...minimalValid, staticPathsTimeoutMs: 0 });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('staticPathsTimeoutMs'))).toBe(true);
  });

  test('rejects negative timeout', () => {
    const err = invalid({ ...minimalValid, staticPathsTimeoutMs: -1000 });
    expect(err).toBeDefined();
  });

  test('rejects fractional timeout', () => {
    const err = invalid({ ...minimalValid, staticPathsTimeoutMs: 1.5 });
    expect(err).toBeDefined();
  });

  test('parseSsgConfig passes staticPathsTimeoutMs through', () => {
    const config = parseSsgConfig({ ...minimalValid, staticPathsTimeoutMs: 120_000 });
    expect(config.staticPathsTimeoutMs).toBe(120_000);
  });
});
