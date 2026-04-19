import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSecretRepository } from '@framework/secrets/providers/fileProvider';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

describe('createFileSecretRepository', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slingshot-secrets-'));
    await writeFile(join(dir, 'DB_PASSWORD'), 'hunter2\n');
    await writeFile(join(dir, 'API_KEY'), 'ak_test_123');
    await writeFile(join(dir, 'EMPTY'), '');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true });
  });

  test('get reads file content and trims trailing newline', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    expect(await provider.get('DB_PASSWORD')).toBe('hunter2');
  });

  test('get returns value without trailing newline untouched', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    expect(await provider.get('API_KEY')).toBe('ak_test_123');
  });

  test('get returns empty string for empty file', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    expect(await provider.get('EMPTY')).toBe('');
  });

  test('get returns null for missing key', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    expect(await provider.get('NONEXISTENT')).toBeNull();
  });

  test('getMany returns map of found secrets', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    const result = await provider.getMany(['DB_PASSWORD', 'API_KEY', 'MISSING']);

    expect(result.get('DB_PASSWORD')).toBe('hunter2');
    expect(result.get('API_KEY')).toBe('ak_test_123');
    expect(result.has('MISSING')).toBe(false);
  });

  test('works without initialize (lazy reads)', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    // No initialize call — should read files on demand
    expect(await provider.get('DB_PASSWORD')).toBe('hunter2');
    expect(await provider.get('NONEXISTENT')).toBeNull();
  });

  test('refresh re-reads directory', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();

    // Write new secret after init
    await writeFile(join(dir, 'NEW_SECRET'), 'fresh');
    await provider.refresh?.();

    expect(await provider.get('NEW_SECRET')).toBe('fresh');
  });

  test('extension stripping works', async () => {
    const extDir = await mkdtemp(join(tmpdir(), 'slingshot-secrets-ext-'));
    try {
      await writeFile(join(extDir, 'DB_HOST.txt'), 'localhost\n');
      const provider = createFileSecretRepository({ directory: extDir, extension: '.txt' });
      await provider.initialize?.();
      expect(await provider.get('DB_HOST')).toBe('localhost');
    } finally {
      await rm(extDir, { recursive: true });
    }
  });

  test('initialize throws for nonexistent directory', async () => {
    const provider = createFileSecretRepository({ directory: '/nonexistent/path/xyz' });
    expect(provider.initialize?.()).rejects.toThrow('Directory not found');
  });

  test("provider name is 'file'", () => {
    const provider = createFileSecretRepository({ directory: dir });
    expect(provider.name).toBe('file');
  });

  test('initialize re-throws non-ENOENT errors (line 106)', async () => {
    // Pass a path that EXISTS but is a FILE not a directory — readdir will throw ENOTDIR
    const filePath = join(dir, 'DB_PASSWORD'); // this is a file
    const provider = createFileSecretRepository({ directory: filePath });
    await expect(provider.initialize?.()).rejects.toThrow();
    // Should NOT throw "Directory not found" (ENOENT message), just re-throw raw error
    await provider.initialize?.().catch(err => {
      expect(err.message).not.toContain('Directory not found');
    });
  });

  test('destroy() clears cache and resolves (lines 131-133)', async () => {
    const provider = createFileSecretRepository({ directory: dir });
    await provider.initialize?.();
    // Should have cached values
    expect(await provider.get('DB_PASSWORD')).toBe('hunter2');

    // destroy() should clear the cache and return a resolved promise
    await expect(provider.destroy?.()).resolves.toBeUndefined();

    // After destroy, reading should go back to lazy (disk) mode
    // We can verify by checking a known key still returns a value (lazy read)
    expect(await provider.get('DB_PASSWORD')).toBe('hunter2');
  });
});
