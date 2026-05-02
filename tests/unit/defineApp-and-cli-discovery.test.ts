import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { defineApp } from '../../src/defineApp';
import { discoverAppConfig, loadAppConfig } from '../../src/cli/commands/start';

describe('defineApp', () => {
  test('returns the input config unchanged (identity)', () => {
    const input = {
      meta: { name: 'test-app', version: '1.0.0' },
      port: 3000,
    } as const;
    const out = defineApp(input);
    expect(out).toBe(input);
  });

  test('preserves typed inference for nested fields', () => {
    const out = defineApp({
      meta: { name: 'typed', version: '1.0.0' },
      db: { redis: false, mongo: false, sqlite: ':memory:' },
    });
    expect(out.meta?.name).toBe('typed');
    expect(out.db?.sqlite).toBe(':memory:');
  });
});

describe('CLI app.config discovery', () => {
  const created: string[] = [];

  afterEach(() => {
    created.length = 0;
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-cli-discovery-'));
    created.push(dir);
    return dir;
  }

  test('finds app.config.ts when present', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'app.config.ts'), 'export default {};\n');
    const found = discoverAppConfig(dir);
    expect(found).toBe(join(dir, 'app.config.ts'));
  });

  test('falls back to app.config.js when only .js exists', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'app.config.js'), 'module.exports = { default: {} };\n');
    const found = discoverAppConfig(dir);
    expect(found).toBe(join(dir, 'app.config.js'));
  });

  test('prefers app.config.ts over app.config.js when both exist', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'app.config.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'app.config.js'), 'module.exports = { default: {} };\n');
    const found = discoverAppConfig(dir);
    expect(found).toBe(join(dir, 'app.config.ts'));
  });

  test('returns null when no config is present', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'subdir'));
    const found = discoverAppConfig(dir);
    expect(found).toBeNull();
  });

  test('respects --config override', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'custom.config.ts'), 'export default {};\n');
    const found = discoverAppConfig(dir, 'custom.config.ts');
    expect(found).toBe(join(dir, 'custom.config.ts'));
  });

  test('throws when --config override points at a missing file', () => {
    const dir = makeTempDir();
    expect(() => discoverAppConfig(dir, 'missing.ts')).toThrow(/not found/);
  });

  test('loadAppConfig returns the default export', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'app.config.ts');
    writeFileSync(
      path,
      `import { defineApp } from '${join(process.cwd(), 'src/defineApp.ts')}';\n` +
        `export default defineApp({ meta: { name: 'loaded', version: '1.0.0' } });\n`,
    );
    const config = await loadAppConfig(path);
    expect(config.meta?.name).toBe('loaded');
  });

  test('loadAppConfig throws when default export is missing', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'app.config.ts');
    writeFileSync(path, 'export const named = {};\n');
    await expect(loadAppConfig(path)).rejects.toThrow(/default value from defineApp/);
  });

  test('loadAppConfig throws when default export is not an object', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'app.config.ts');
    writeFileSync(path, 'export default "not an object";\n');
    await expect(loadAppConfig(path)).rejects.toThrow(/default value from defineApp/);
  });

  test('loadAppConfig wraps import errors with config-path context', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'app.config.ts');
    // Syntax error inside the file — Bun will fail to parse at import time.
    writeFileSync(path, 'export default defineApp({ unclosed: \n');
    await expect(loadAppConfig(path)).rejects.toThrow(/Failed to load.*app\.config\.ts/);
  });
});
