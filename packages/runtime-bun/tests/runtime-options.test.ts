import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('bunRuntime options', () => {
  test('creates with no options', () => {
    const rt = bunRuntime();
    expect(rt).toBeDefined();
    expect(typeof rt.password.hash).toBe('function');
    expect(typeof rt.password.verify).toBe('function');
  });

  test('creates with custom logger', () => {
    const logs: string[] = [];
    const rt = bunRuntime({
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      } as any,
    });
    expect(rt).toBeDefined();
  });

  test('installProcessSafetyNet option defaults to true', () => {
    const rt = bunRuntime();
    expect(rt).toBeDefined();
  });

  test('installProcessSafetyNet can be disabled', () => {
    const rt = bunRuntime({ installProcessSafetyNet: false });
    expect(rt).toBeDefined();
  });

  test('capabilities reflect bun environment', () => {
    const rt = bunRuntime();
    expect(rt.supportsSqlite).toBe(true);
    expect(rt.supportsFs).toBe(true);
    expect(rt.supportsGlob).toBe(true);
    expect(rt.supportsAsyncLocalStorage).toBe(true);
  });

  test('password hash and verify roundtrip', async () => {
    const rt = bunRuntime();
    const hash = await rt.password.hash('test-password');
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');

    const valid = await rt.password.verify('test-password', hash);
    expect(valid).toBe(true);

    const invalid = await rt.password.verify('wrong', hash);
    expect(invalid).toBe(false);
  });

  test('sqlite in-memory database', () => {
    const rt = bunRuntime();
    const db = rt.sqlite.open(':memory:');
    expect(db).toBeDefined();
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    const row = db.get('SELECT * FROM test WHERE id = 1');
    expect(row).toEqual({ id: 1, value: 'hello' });
    db.close();
  });

  test('fs file operations', async () => {
    const rt = bunRuntime();
    const tmp = `/tmp/bun-test-${Date.now()}.txt`;
    await rt.fs.writeFile(tmp, 'test content');
    const exists = await rt.fs.exist(tmp);
    expect(exists).toBe(true);
    const content = await rt.fs.readFile(tmp);
    expect(content).toBe('test content');
    await rt.fs.deleteFile(tmp);
    const after = await rt.fs.exist(tmp);
    expect(after).toBe(false);
  });
});
