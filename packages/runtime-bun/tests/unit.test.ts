import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-runtime-bun-unit-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-bun unit', () => {
  test('supportsAsyncLocalStorage is true', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(runtime.supportsAsyncLocalStorage).toBe(true);
  });

  test('password hash produces unique values for same input', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const h1 = await runtime.password.hash('same-password');
    const h2 = await runtime.password.hash('same-password');
    expect(h1).not.toBe(h2);
  });

  test('sqlite open with in-memory database works without WAL check', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('INSERT INTO t VALUES (1)');
    const row = db.query<{ x: number }>('SELECT x FROM t').get();
    expect(row?.x).toBe(1);
    db.close();
  });

  test('sqlite close prevents further operations', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(join(tempDir, 'close.db'));
    db.run('CREATE TABLE t (x INTEGER)');
    db.close();
    expect(() => db.run('INSERT INTO t VALUES (1)')).toThrow();
  });

  test('file write and read UTF-8 content', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const path = join(tempDir, 'utf8.txt');
    await runtime.fs.write(path, 'héllo wörld 🎉');
    const bytes = await runtime.fs.readFile(path);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('héllo wörld 🎉');
  });

  test('file exists returns false for missing path', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(await runtime.fs.exists(join(tempDir, 'nope.txt'))).toBe(false);
  });

  test('fs.readFile returns null for missing file (does not throw)', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const result = await runtime.fs.readFile(join(tempDir, 'does-not-exist'));
    expect(result).toBeNull();
  });

  test('password verify returns false for empty hash', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    expect(await runtime.password.verify('anything', '')).toBe(false);
  });

  test('unix socket path is forwarded to Bun.serve', () => {
    const originalServe = Bun.serve;
    let capturedOpts: Record<string, unknown> = {};
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        capturedOpts = opts;
        return {
          port: undefined,
          stop: () => undefined,
          publish: () => undefined,
          upgrade: () => true,
        };
      },
    });
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      runtime.server.listen({
        unix: '/tmp/runtime-bun-test.sock',
        fetch: () => new Response('ok'),
      });
      expect(capturedOpts.unix).toBe('/tmp/runtime-bun-test.sock');
      expect(capturedOpts.port).toBeUndefined();
      expect(capturedOpts.hostname).toBeUndefined();
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('sqlite transaction returns caller value', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(join(tempDir, 'txval.db'));
    db.run('CREATE TABLE t (x INTEGER)');
    const txn = db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)');
      return 'txn-result';
    });
    expect(txn()).toBe('txn-result');
    db.close();
  });

  test('sqlite prepared statement returns null for missing row', () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    const db = runtime.sqlite.open(join(tempDir, 'nullrow.db'));
    db.run('CREATE TABLE t (x TEXT)');
    const row = db.prepare<{ x: string }>('SELECT x FROM t WHERE x = ?').get('missing');
    expect(row).toBeNull();
    db.close();
  });

  test('server publish failure logs without throwing', () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 9000,
          stop: () => undefined,
          publish() {
            throw new Error('publish-boom');
          },
          upgrade: () => true,
        };
      },
    });
    const originalErr = console.error;
    const errs: string[] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });
      expect(() => server.publish('room', 'msg')).not.toThrow();
      expect(errs.some(e => e.includes('publish-boom'))).toBe(true);
    } finally {
      console.error = originalErr;
      Object.assign(Bun, { serve: originalServe });
    }
  });
});
