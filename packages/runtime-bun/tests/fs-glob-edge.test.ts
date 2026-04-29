import { unlink } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('Bun runtime — filesystem operations', () => {
  test('write and read file roundtrip', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-runtime-fs-${Date.now()}.txt`;
    await rt.fs.write(path, 'hello bun');
    const content = await rt.readFile(path);
    expect(content).toBe('hello bun');
    await unlink(path);
  });

  test('exists returns false for missing file', async () => {
    const rt = bunRuntime();
    const exists = await rt.fs.exists('/tmp/definitely-not-a-real-file-12345.txt');
    expect(exists).toBe(false);
  });

  test('exists returns true for existing file', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-exist-${Date.now()}.txt`;
    await rt.fs.write(path, 'test');
    const exists = await rt.fs.exists(path);
    expect(exists).toBe(true);
    await unlink(path);
  });

  test('exists returns false after external removal', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-delete-${Date.now()}.txt`;
    await rt.fs.write(path, 'test');
    await unlink(path);
    const exists = await rt.fs.exists(path);
    expect(exists).toBe(false);
  });

  test('readFile on nonexistent file returns null', async () => {
    const rt = bunRuntime();
    await expect(rt.fs.readFile('/tmp/nonexistent-file-99999.txt')).resolves.toBeNull();
  });

  test('glob scan finds matching files', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-glob-test-${Date.now()}.ts`;
    await rt.fs.write(path, '// test');
    const matches = await rt.glob.scan('bun-glob-test-*.ts', { cwd: '/tmp' });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some(m => m.includes('bun-glob-test-'))).toBe(true);
    await unlink(path);
  });
});
