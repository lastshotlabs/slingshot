// packages/slingshot-ssg/tests/rsc-manifest.test.ts
//
// Direct unit tests for loadRscManifest(). The function is tested indirectly
// through the CLI integration (cli.test.ts), but this file exhaustively covers
// every failure mode and edge case at the unit level so the triage path for a
// broken --rsc-manifest flag is unambiguous.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadRscManifest } from '../src/cli';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slingshot-ssg-rsc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadRscManifest — valid manifests', () => {
  test('loads a valid manifest with modules map', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'rsc-manifest.json');
    writeFileSync(
      p,
      JSON.stringify({
        modules: { 'src/App.tsx': { id: 'app', chunks: ['assets/app.js'] } },
      }),
      'utf8',
    );

    const result = await loadRscManifest(p);
    expect(result).toEqual({
      modules: { 'src/App.tsx': { id: 'app', chunks: ['assets/app.js'] } },
    });
  });

  test('passes through unknown top-level keys (passthrough schema)', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'rsc-manifest-ext.json');
    writeFileSync(
      p,
      JSON.stringify({
        modules: {},
        customField: { extra: 'data' },
        buildTimestamp: 1_700_000_000,
      }),
      'utf8',
    );

    const result = await loadRscManifest(p);
    expect((result as Record<string, unknown>).modules).toEqual({});
    expect((result as Record<string, unknown>).customField).toEqual({ extra: 'data' });
    expect((result as Record<string, unknown>).buildTimestamp).toBe(1_700_000_000);
  });

  test('handles empty modules map', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'rsc-manifest-empty.json');
    writeFileSync(p, JSON.stringify({ modules: {} }), 'utf8');

    const result = await loadRscManifest(p);
    expect(result).toEqual({ modules: {} });
  });
});

// ---------------------------------------------------------------------------
// File-level errors
// ---------------------------------------------------------------------------

describe('loadRscManifest — file not found or unreadable', () => {
  test('throws labeled [slingshot-ssg] error when file does not exist', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'does-not-exist.json');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('--rsc-manifest file not readable');
  });

  test('error message includes the absolute path', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'specific-missing.json');

    await expect(loadRscManifest(p)).rejects.toThrow(p);
  });

  test('error has cause set to the original ENOENT error', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'cause-check.json');

    try {
      await loadRscManifest(p);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });
});

describe('loadRscManifest — empty file', () => {
  test('throws labeled error when the file is empty', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'empty-rsc-manifest.json');
    writeFileSync(p, '', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('is empty');
  });

  test('error suggests expected format (snapshotSsr with rsc: true)', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'empty-manifest.json');
    writeFileSync(p, '', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('snapshotSsr');
  });
});

describe('loadRscManifest — malformed JSON', () => {
  test('throws labeled error for truncated JSON', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'truncated.json');
    writeFileSync(p, '{ "modules": { "broken": ', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('not valid JSON');
  });

  test('error includes JSON.parse detail message', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'bad-json.json');
    writeFileSync(p, '{ invalid json }', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('JSON Parse error');
  });

  test('error suggests expected format', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'bad-syntax.json');
    writeFileSync(p, 'not json at all', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('snapshotSsr');
  });
});

// ---------------------------------------------------------------------------
// Schema validation errors
// ---------------------------------------------------------------------------

describe('loadRscManifest — wrong shape', () => {
  test('rejects a JSON array with a clear schema error', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'array-manifest.json');
    writeFileSync(p, JSON.stringify(['not', 'an', 'object']), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('unexpected shape');
  });

  test('rejects a JSON string root', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'string-manifest.json');
    writeFileSync(p, JSON.stringify('just a string'), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('unexpected shape');
  });

  test('rejects a JSON number root', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'number-manifest.json');
    writeFileSync(p, JSON.stringify(42), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('unexpected shape');
  });

  test('rejects null root', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'null-manifest.json');
    writeFileSync(p, JSON.stringify(null), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('unexpected shape');
  });

  test('rejects when modules field is missing', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'no-modules.json');
    writeFileSync(p, JSON.stringify({ someField: 'value' }), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('modules');
  });

  test('rejects when modules is a string instead of a map', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'modules-string.json');
    writeFileSync(p, JSON.stringify({ modules: 'not-a-record' }), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('modules');
  });

  test('rejects when modules is an array', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'modules-array.json');
    writeFileSync(p, JSON.stringify({ modules: [] }), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('modules');
  });

  test('schema error lists the specific field path and reason', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'reason-check.json');
    writeFileSync(p, JSON.stringify({ modules: 'invalid' }), 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow('modules');
  });
});

// ---------------------------------------------------------------------------
// Non-ENOENT read errors
// ---------------------------------------------------------------------------

describe('loadRscManifest — other read errors', () => {
  test('wraps non-ENOENT read errors with generic label', async () => {
    const dir = makeTempDir();
    // A path that exists but is a directory, not a file — Bun.file().text() will
    // throw an error that is not ENOENT.
    const p = dir;

    await expect(loadRscManifest(p)).rejects.toThrow('[slingshot-ssg]');
    await expect(loadRscManifest(p)).rejects.toThrow('could not be read');
  });
});
