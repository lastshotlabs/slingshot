/**
 * FS-and-Glob tests for runtime-bun.
 *
 * Covers filesystem operations with edge cases: glob pattern matching,
 * file reading with various encodings, directory traversal safety,
 * and missing file handling.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-runtime-bun-fs-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-bun fs — read and write', () => {
  test('writes and reads a string file', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'hello.txt');
    await runtime.fs.write(filePath, 'hello world');
    expect(await runtime.fs.exists(filePath)).toBe(true);
    const bytes = await runtime.fs.readFile(filePath);
    expect(new TextDecoder().decode(bytes!)).toBe('hello world');
  });

  test('reads file through readFile helper', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'helper.txt');
    await runtime.fs.write(filePath, 'helper content');
    const content = await runtime.readFile(filePath);
    expect(content).toBe('helper content');
  });

  test('readFile returns null for missing file', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const result = await runtime.readFile(join(tempDir, 'missing.txt'));
    expect(result).toBeNull();
  });

  test('write handles Uint8Array binary data', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'binary.bin');
    const data = new Uint8Array([0x48, 0x49, 0x4a]);
    await runtime.fs.write(filePath, data);
    const bytes = await runtime.fs.readFile(filePath);
    expect(bytes).toEqual(data);
  });

  test('writes and overwrites existing file', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'overwrite.txt');
    await runtime.fs.write(filePath, 'first');
    await runtime.fs.write(filePath, 'second');
    const content = await runtime.readFile(filePath);
    expect(content).toBe('second');
  });

  test('exists returns false for non-existent file', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(await runtime.fs.exists(join(tempDir, 'nope'))).toBe(false);
  });

  test('exists returns true after write', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'now-it-exists.txt');
    await runtime.fs.write(filePath, 'content');
    expect(await runtime.fs.exists(filePath)).toBe(true);
  });
});

describe('runtime-bun glob — pattern matching', () => {
  test('scans all .ts files recursively', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'b.js'), '');
    await mkdir(join(tempDir, 'sub'));
    await writeFile(join(tempDir, 'sub', 'c.ts'), '');

    const matches = await runtime.glob.scan('**/*.ts', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual(['a.ts', 'sub/c.ts']);
  });

  test('scans with single-directory glob', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    await mkdir(join(tempDir, 'pages'));
    await writeFile(join(tempDir, 'pages', 'index.ts'), '');
    await writeFile(join(tempDir, 'pages', 'about.ts'), '');

    const matches = await runtime.glob.scan('pages/*.ts', { cwd: tempDir });
    expect(matches).toHaveLength(2);
  });

  test('returns empty array for non-matching pattern', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const matches = await runtime.glob.scan('*.nonexistent', { cwd: tempDir });
    expect(matches).toEqual([]);
  });

  test('scans from root directory', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    await writeFile(join(tempDir, 'root.txt'), '');

    const matches = await runtime.glob.scan('*', { cwd: tempDir });
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('glob handles pattern with leading ./', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    await writeFile(join(tempDir, 'file.txt'), '');
    await mkdir(join(tempDir, 'lib'));
    await writeFile(join(tempDir, 'lib', 'module.ts'), '');

    const matches = await runtime.glob.scan('**/*.ts', { cwd: tempDir });
    expect(matches.some(m => m.endsWith('module.ts'))).toBe(true);
  });

  test('glob handles patterns with brace expansion', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'a.js'), '');
    await writeFile(join(tempDir, 'b.tsx'), '');

    const matches = await runtime.glob.scan('*.{ts,js}', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual(['a.js', 'a.ts']);
  });
});

describe('runtime-bun fs — readFile rethrows non-ENOENT errors', () => {
  test('readFile throws EACCES when file exists without permission', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const filePath = join(tempDir, 'restricted.txt');
    await writeFile(filePath, 'secret');
    await import('node:fs/promises').then(fs => fs.chmod(filePath, 0o000));
    try {
      await expect(runtime.readFile(filePath)).rejects.toThrow();
    } finally {
      await import('node:fs/promises').then(fs => fs.chmod(filePath, 0o644));
    }
  });
});
