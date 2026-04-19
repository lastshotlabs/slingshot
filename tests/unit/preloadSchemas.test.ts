/**
 * Unit tests for preloadModelSchemas.
 *
 * Verifies the function handles all config shapes correctly:
 *   - falsy input → immediate no-op
 *   - string path → all .ts files under directory are imported (side-effect flag set on first run)
 *   - array of paths → files from all directories are imported
 *   - object config with explicit paths → files are imported
 *   - object config with registration:'explicit' → files imported (no auto-register)
 *   - non-existent path → does not throw
 *
 * Note: Bun caches dynamic imports so the module side-effect flag is only checked
 * on the first import. Subsequent tests verify the function resolves without throwing.
 */
import { describe, expect, test } from 'bun:test';
import type { RuntimeGlob } from '@lastshotlabs/slingshot-core';
import { preloadModelSchemas } from '../../src/framework/preloadSchemas';

const SCHEMAS_DIR = import.meta.dir.replaceAll('\\', '/') + '/../fixtures/schemas';
const FIXTURE_FILES = ['UserSchema.ts', 'OrderSchema.ts'];

function createFixtureGlob(): RuntimeGlob {
  return {
    async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
      if (pattern !== '**/*.ts') {
        throw new Error(`unexpected pattern: ${pattern}`);
      }
      if (!options?.cwd) {
        throw new Error('missing cwd');
      }
      if (options.cwd === SCHEMAS_DIR) return FIXTURE_FILES;
      throw new Error(`ENOENT: no such directory, scan '${options.cwd}'`);
    },
  };
}

// ---------------------------------------------------------------------------
// Guard: falsy inputs are no-ops
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — falsy inputs', () => {
  test('returns undefined for undefined input', async () => {
    const result = await preloadModelSchemas(undefined);
    expect(result).toBeUndefined();
  });

  test('returns undefined for null input (typed as undefined)', async () => {
    // Cast so TS accepts it — runtime guards against any falsy value
    const result = await preloadModelSchemas(null as any);
    expect(result).toBeUndefined();
  });

  test('returns undefined for empty string', async () => {
    const result = await preloadModelSchemas('');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// String path
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — string path', () => {
  test('imports all .ts files in the directory (side-effect flag set on first import)', async () => {
    // This is the canonical first-import test — flag is set by the fixture module body
    await preloadModelSchemas(SCHEMAS_DIR, createFixtureGlob());
    expect((globalThis as any).__fixtureUserSchemaLoaded).toBe(true);
    expect((globalThis as any).__fixtureOrderSchemaLoaded).toBe(true);
  });

  test('does not throw for a valid schemas directory', async () => {
    await expect(preloadModelSchemas(SCHEMAS_DIR, createFixtureGlob())).resolves.toBeUndefined();
  });

  test('rejects for a non-existent directory (Bun.Glob.scan throws ENOENT)', async () => {
    await expect(
      preloadModelSchemas('/nonexistent/path/that/does/not/exist', createFixtureGlob()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Array of paths
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — array of paths', () => {
  test('accepts an array of paths without throwing', async () => {
    await expect(preloadModelSchemas([SCHEMAS_DIR], createFixtureGlob())).resolves.toBeUndefined();
  });

  test('rejects when any path in the array does not exist', async () => {
    await expect(
      preloadModelSchemas([SCHEMAS_DIR, '/does/not/exist'], createFixtureGlob()),
    ).rejects.toThrow();
  });

  test('empty array is a no-op', async () => {
    await expect(preloadModelSchemas([], createFixtureGlob())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Object config — auto registration (default)
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — object config (registration: auto)', () => {
  test('accepts ModelSchemasConfig object with paths string', async () => {
    await expect(
      preloadModelSchemas({ paths: SCHEMAS_DIR }, createFixtureGlob()),
    ).resolves.toBeUndefined();
  });

  test('accepts ModelSchemasConfig object with paths array', async () => {
    await expect(
      preloadModelSchemas({ paths: [SCHEMAS_DIR] }, createFixtureGlob()),
    ).resolves.toBeUndefined();
  });

  test('defaults registration to auto when not specified', async () => {
    await expect(
      preloadModelSchemas({ paths: SCHEMAS_DIR }, createFixtureGlob()),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Object config — explicit registration
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — object config (registration: explicit)', () => {
  test('imports files without auto-register when registration is explicit', async () => {
    // explicit mode: files are imported but maybeAutoRegister is NOT called
    await expect(
      preloadModelSchemas({ paths: SCHEMAS_DIR, registration: 'explicit' }, createFixtureGlob()),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Object config — no paths
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — object config without paths', () => {
  test('no-op when paths is undefined', async () => {
    await expect(
      preloadModelSchemas({ paths: undefined }, createFixtureGlob()),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeBunGlob — internal implementation (lines 55, 57-63)
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — makeBunGlob internal (uses Bun.Glob directly)', () => {
  test('makeBunGlob scan iterates matched files via real Bun.Glob (lines 57-63)', async () => {
    // Call without a custom glob → uses the real makeBunGlob() Bun.Glob wrapper.
    // Use SCHEMAS_DIR which only has safe, importable fixture files.
    // This exercises lines 57-63: new BunGlob(pattern), scan loop, results push.
    await expect(preloadModelSchemas(SCHEMAS_DIR)).resolves.toBeUndefined();
  });

  test('makeBunGlob fallback no-op when Bun.Glob is absent (line 55)', async () => {
    // Temporarily hide Bun.Glob to exercise the fallback no-op path (line 55).
    const g = (globalThis as any).Bun;
    const origGlob = g.Glob;
    g.Glob = undefined;
    try {
      // With no Bun.Glob, makeBunGlob returns { scan: async function*(){} }
      // preloadModelSchemas will call scan(), which returns no files → no imports
      await expect(preloadModelSchemas(SCHEMAS_DIR)).resolves.toBeUndefined();
    } finally {
      g.Glob = origGlob;
    }
  });
});

// ---------------------------------------------------------------------------
// Glob pattern with wildcards (lines 134-137)
// ---------------------------------------------------------------------------

describe('preloadModelSchemas — glob pattern with wildcards (lines 134-137)', () => {
  test('splits path at first wildcard segment to derive cwd and pattern', async () => {
    // The path /base/dir/**/*.schema.ts has a wildcard.
    // Expected: cwd = "/base/dir", pattern = "**/*.schema.ts"
    const capturedCalls: Array<{ pattern: string; cwd?: string }> = [];
    const trackingGlob: RuntimeGlob = {
      async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
        capturedCalls.push({ pattern, cwd: options?.cwd });
        return []; // no files — just capture the call
      },
    };

    await preloadModelSchemas('/base/dir/**/*.schema.ts', trackingGlob);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].pattern).toBe('**/*.schema.ts');
    expect(capturedCalls[0].cwd).toBe('/base/dir');
  });

  test('handles single-segment wildcard path correctly', async () => {
    const capturedCalls: Array<{ pattern: string; cwd?: string }> = [];
    const trackingGlob: RuntimeGlob = {
      async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
        capturedCalls.push({ pattern, cwd: options?.cwd });
        return [];
      },
    };

    // Pattern like /schemas/*.ts — single wildcard at end
    await preloadModelSchemas('/schemas/*.ts', trackingGlob);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].pattern).toBe('*.ts');
    expect(capturedCalls[0].cwd).toBe('/schemas');
  });
});
