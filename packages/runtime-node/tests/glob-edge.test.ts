import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-glob-edge-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-node glob — pattern edge cases', () => {
  // -----------------------------------------------------------------------
  // Basic patterns
  // -----------------------------------------------------------------------

  test('scans files with simple wildcard', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'b.ts'), '');
    await writeFile(join(tempDir, 'c.js'), '');

    const matches = await runtime.glob.scan('*.ts', { cwd: tempDir });
    expect(matches).toHaveLength(2);
    expect(matches.map(m => m.replace(/\\/g, '/')).sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('scans files with recursive wildcard', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await mkdir(join(tempDir, 'sub'));
    await writeFile(join(tempDir, 'sub', 'b.ts'), '');

    const matches = await runtime.glob.scan('**/*.ts', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual(['a.ts', 'sub/b.ts']);
  });

  // -----------------------------------------------------------------------
  // Special patterns
  // -----------------------------------------------------------------------

  test('scans with brace expansion', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'a.js'), '');
    await writeFile(join(tempDir, 'b.tsx'), '');

    const matches = await runtime.glob.scan('*.{ts,js}', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual(['a.js', 'a.ts']);
  });

  test('returns empty array for non-matching pattern', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'readme.md'), '');
    const matches = await runtime.glob.scan('*.nonexistent', { cwd: tempDir });
    expect(matches).toEqual([]);
  });

  test('scans with single-character wildcard', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'ab.ts'), '');
    await writeFile(join(tempDir, 'abc.ts'), '');

    const matches = await runtime.glob.scan('?.ts', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual(['a.ts']);
  });

  // -----------------------------------------------------------------------
  // Dotfiles
  // -----------------------------------------------------------------------

  test('does not match dotfiles by default', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, '.hidden'), '');
    await writeFile(join(tempDir, 'visible'), '');

    const matches = await runtime.glob.scan('*', { cwd: tempDir });
    // By default, fast-glob ignores dotfiles
    expect(matches.map(m => m.replace(/\\/g, '/'))).not.toContain('.hidden');
    expect(matches.map(m => m.replace(/\\/g, '/'))).toContain('visible');
  });

  // -----------------------------------------------------------------------
  // Directory structure
  // -----------------------------------------------------------------------

  test('scans deeply nested files', async () => {
    const runtime = nodeRuntime();
    await mkdir(join(tempDir, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(tempDir, 'a', 'b', 'c', 'deep.txt'), '');

    const matches = await runtime.glob.scan('**/*.txt', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/'));
    expect(normalized).toContain('a/b/c/deep.txt');
  });

  test('returns files in root directory only with single-star', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'root.txt'), '');
    await mkdir(join(tempDir, 'sub'));
    await writeFile(join(tempDir, 'sub', 'nested.txt'), '');

    const matches = await runtime.glob.scan('*.txt', { cwd: tempDir });
    const normalized = matches.map(m => m.replace(/\\/g, '/'));
    expect(normalized).toEqual(['root.txt']);
  });

  // -----------------------------------------------------------------------
  // Missing directory
  // -----------------------------------------------------------------------

  test('returns empty array when cwd does not exist', async () => {
    const runtime = nodeRuntime();
    const matches = await runtime.glob.scan('*', { cwd: '/nonexistent-path-12345' });
    expect(matches).toEqual([]);
  });
});
