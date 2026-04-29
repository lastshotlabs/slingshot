import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('Bun runtime — filesystem operations', () => {
  test('write and read file roundtrip', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-runtime-fs-${Date.now()}.txt`;
    await rt.fs.writeFile(path, 'hello bun');
    const content = await rt.fs.readFile(path);
    expect(content).toBe('hello bun');
    await rt.fs.deleteFile(path);
  });

  test('exist returns false for missing file', async () => {
    const rt = bunRuntime();
    const exists = await rt.fs.exist('/tmp/definitely-not-a-real-file-12345.txt');
    expect(exists).toBe(false);
  });

  test('exist returns true for existing file', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-exist-${Date.now()}.txt`;
    await rt.fs.writeFile(path, 'test');
    const exists = await rt.fs.exist(path);
    expect(exists).toBe(true);
    await rt.fs.deleteFile(path);
  });

  test('deleteFile removes file', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-delete-${Date.now()}.txt`;
    await rt.fs.writeFile(path, 'test');
    await rt.fs.deleteFile(path);
    const exists = await rt.fs.exist(path);
    expect(exists).toBe(false);
  });

  test('deleteFile on nonexistent file does not throw', async () => {
    const rt = bunRuntime();
    await expect(rt.fs.deleteFile('/tmp/nonexistent-file-99999.txt')).resolves.toBeUndefined();
  });

  test('glob scan finds matching files', async () => {
    const rt = bunRuntime();
    const path = `/tmp/bun-glob-test-${Date.now()}.ts`;
    await rt.fs.writeFile(path, '// test');
    const matches = await rt.glob.scan('/tmp/bun-glob-test-*.ts');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.includes('bun-glob-test-'))).toBe(true);
    await rt.fs.deleteFile(path);
  });
});
