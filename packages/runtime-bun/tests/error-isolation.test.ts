import { describe, expect, test } from 'bun:test';
import { BunRuntimeError, bunRuntime, resetProcessSafetyNetForTest } from '../src/index';

describe('Bun runtime — error isolation', () => {
  test('BunRuntimeError extends Error', () => {
    const err = new BunRuntimeError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BunRuntimeError');
  });

  test('BunRuntimeError includes prefix', () => {
    const err = new BunRuntimeError('something went wrong');
    expect(err.message).toContain('[runtime-bun]');
    expect(err.message).toContain('something went wrong');
  });

  test('password errors are isolated from crashing server', async () => {
    const rt = bunRuntime();
    // Malformed hash should return false, not throw
    const result = await rt.password.verify('password', 'bad-hash-format');
    expect(result).toBe(false);
  });

  test('sqlite operations throw descriptive errors', () => {
    const rt = bunRuntime();
    const db = rt.sqlite.open(':memory:');
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    // Duplicate insert
    db.run('INSERT INTO test VALUES (1)');
    expect(() => db.run('INSERT INTO test VALUES (1)')).toThrow();
    db.close();
  });

  test('operating on closed sqlite database throws', () => {
    const rt = bunRuntime();
    const db = rt.sqlite.open(':memory:');
    db.close();
    expect(() => db.run('CREATE TABLE test (id INTEGER PRIMARY KEY)')).toThrow();
  });

  test('safety net can be reset for testing', () => {
    // resetProcessSafetyNetForTest should not throw
    expect(() => resetProcessSafetyNetForTest()).not.toThrow();
  });

  test('safety net reset is idempotent', () => {
    resetProcessSafetyNetForTest();
    resetProcessSafetyNetForTest();
    // Second call should not throw
    expect(true).toBe(true);
  });

  test('file operations handle missing files gracefully', async () => {
    const rt = bunRuntime();
    const exists = await rt.fs.exists('/nonexistent/path/file.txt');
    expect(exists).toBe(false);
  });
});
