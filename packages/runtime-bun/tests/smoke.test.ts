import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-runtime-bun-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-bun smoke', () => {
  test('hashes and verifies passwords', async () => {
    const runtime = bunRuntime();
    const hash = await runtime.password.hash('hunter2');

    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify('hunter2', hash)).toBe(true);
    expect(await runtime.password.verify('wrong', hash)).toBe(false);
  });

  test('supports sqlite CRUD, prepared statements, and transactions', () => {
    const runtime = bunRuntime();
    const db = runtime.sqlite.open(join(tempDir, 'runtime.db'));

    db.run('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run('INSERT INTO items VALUES (?, ?)', 'a', 'alpha');

    const update = db.prepare<{ value: string }>('UPDATE items SET value = ? WHERE id = ?');
    expect(update.run('beta', 'a').changes).toBe(1);

    const preparedSelect = db.prepare<{ id: string }>('SELECT id FROM items ORDER BY id');

    const transfer = db.transaction(() => {
      db.run('INSERT INTO items VALUES (?, ?)', 'b', 'bravo');
      db.run('INSERT INTO items VALUES (?, ?)', 'c', 'charlie');
    });
    transfer();

    expect(
      db.query<{ id: string; value: string }>('SELECT * FROM items WHERE id = ?').get('a'),
    ).toEqual({ id: 'a', value: 'beta' });
    expect(
      db
        .query<{ id: string }>('SELECT id FROM items ORDER BY id')
        .all()
        .map(row => row.id),
    ).toEqual(['a', 'b', 'c']);
    expect(preparedSelect.all().map(row => row.id)).toEqual(['a', 'b', 'c']);

    db.query('INSERT INTO items VALUES (?, ?)').run('d', 'delta');
    expect(
      db.query<{ value: string }>('SELECT value FROM items WHERE id = ?').get('d')?.value,
    ).toBe('delta');
    expect(
      db.prepare<{ value: string }>('SELECT value FROM items WHERE id = ?').get('missing'),
    ).toBeNull();

    db.close();
  });

  test('reads and writes files and returns null for missing runtime reads', async () => {
    const runtime = bunRuntime();
    const filePath = join(tempDir, 'hello.txt');

    await runtime.fs.write(filePath, 'hello world');
    expect(await runtime.fs.exists(filePath)).toBe(true);

    const bytes = await runtime.fs.readFile(filePath);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('hello world');
    expect(await runtime.readFile(filePath)).toBe('hello world');
    expect(await runtime.readFile(join(tempDir, 'missing.txt'))).toBeNull();
  });

  test('runtime.readFile rethrows read errors on existing files', async () => {
    const runtime = bunRuntime();
    const filePath = join(tempDir, 'no-perms.txt');
    await writeFile(filePath, 'secret');
    await import('node:fs/promises').then(fs => fs.chmod(filePath, 0o000));
    try {
      await expect(runtime.readFile(filePath)).rejects.toThrow();
    } finally {
      await import('node:fs/promises').then(fs => fs.chmod(filePath, 0o644));
    }
  });

  test('scans files with glob support', async () => {
    const runtime = bunRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'b.js'), '');
    await mkdir(join(tempDir, 'nested'));
    await writeFile(join(tempDir, 'nested', 'c.ts'), '');

    const matches = await runtime.glob.scan('**/*.ts', { cwd: tempDir });
    expect(matches.map(match => match.replace(/\\/g, '/')).sort()).toEqual(['a.ts', 'nested/c.ts']);
  });

  test('wraps Bun.serve with a usable server instance facade', async () => {
    const runtime = bunRuntime();
    const server = runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      const response = await fetch(`http://127.0.0.1:${server.port}`);
      expect(await response.text()).toBe('ok');
    } finally {
      server.stop(true);
    }
  });

  test('sqlite opens in WAL mode', () => {
    const runtime = bunRuntime();
    const db = runtime.sqlite.open(join(tempDir, 'wal.db'));
    const result = db.query<{ journal_mode: string }>('PRAGMA journal_mode').get();
    expect(result?.journal_mode).toBe('wal');
    db.close();
  });

  test('server stop() returns a Promise', async () => {
    const runtime = bunRuntime();
    const server = runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    const result = server.stop();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test('server calls error callback when fetch handler throws', async () => {
    const runtime = bunRuntime();
    const errors: Error[] = [];
    const server = runtime.server.listen({
      port: 0,
      fetch() {
        throw new Error('handler-boom');
      },
      error(err: Error) {
        errors.push(err);
        return new Response('caught', { status: 500 });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('handler-boom');
    } finally {
      await server.stop();
    }
  });

  test('sqlite transaction rolls back on throw', () => {
    const runtime = bunRuntime();
    const db = runtime.sqlite.open(join(tempDir, 'tx.db'));
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const failing = db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 'x');
      throw new Error('rollback me');
    });
    expect(() => failing()).toThrow('rollback me');
    expect(db.query<{ count: number }>('SELECT COUNT(*) as count FROM t').get()?.count).toBe(0);
    db.close();
  });

  test('tls option is forwarded to Bun.serve and throws on invalid cert material', () => {
    const runtime = bunRuntime();
    // Passing invalid TLS key/cert should produce a deterministic error from Bun.serve
    // rather than silently ignoring the tls option.
    expect(() =>
      runtime.server.listen({
        port: 0,
        fetch() {
          return new Response('ok');
        },
        tls: { key: 'not-a-real-key', cert: 'not-a-real-cert' },
      }),
    ).toThrow();
  });

  test('async fetch rejection forwards to error callback', async () => {
    const runtime = bunRuntime();
    const errors: Error[] = [];
    const server = runtime.server.listen({
      port: 0,
      async fetch() {
        await Promise.resolve();
        throw new Error('async-boom');
      },
      error(err: Error) {
        errors.push(err);
        return new Response('async-caught', { status: 500 });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('async-caught');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('async-boom');
    } finally {
      await server.stop();
    }
  });

  test('async fetch rejection without error callback returns 500 and logs', async () => {
    const runtime = bunRuntime();
    const originalErr = console.error;
    const calls: string[] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args.map(String).join(' '));
    };
    const server = runtime.server.listen({
      port: 0,
      async fetch() {
        throw new Error('lonely-async-boom');
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(500);
      // Structured log includes phase and message — match on either form.
      expect(calls.some(line => line.includes('lonely-async-boom'))).toBe(true);
    } finally {
      console.error = originalErr;
      await server.stop();
    }
  });

  test('password verify returns false for malformed hash', async () => {
    const runtime = bunRuntime();
    expect(await runtime.password.verify('password', 'not-a-real-hash')).toBe(false);
  });

  test('maxRequestBodySize default is 128 MiB and override is forwarded', () => {
    const originalServe = Bun.serve;
    const calls: Array<Record<string, unknown>> = [];
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        calls.push(opts);
        return {
          port: 1234,
          stop: () => undefined,
          publish: () => undefined,
          upgrade: () => true,
        };
      },
    });
    try {
      const runtime = bunRuntime();
      runtime.server.listen({ port: 0, fetch: () => new Response('ok') });
      expect(calls[0]?.maxRequestBodySize).toBe(128 * 1024 * 1024);
      runtime.server.listen({ port: 0, maxRequestBodySize: 1024, fetch: () => new Response('ok') });
      expect(calls[1]?.maxRequestBodySize).toBe(1024);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('websocket handler errors are logged but do not crash the server', async () => {
    const originalErr = console.error;
    const errs: string[] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
    const originalServe = Bun.serve;
    let captured: {
      open?: (ws: unknown) => unknown;
      message?: (ws: unknown, m: string) => unknown;
    } = {};
    Object.assign(Bun, {
      serve(opts: { websocket?: typeof captured }) {
        captured = (opts.websocket ?? {}) as typeof captured;
        return {
          port: 4321,
          stop: () => undefined,
          publish: () => undefined,
          upgrade: () => true,
        };
      },
    });
    try {
      const runtime = bunRuntime();
      runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {
            throw new Error('open-boom');
          },
          message() {
            throw new Error('msg-boom');
          },
          close() {},
        },
      });
      // Both should be wrapped to swallow + log
      await Promise.resolve(captured.open?.({}));
      await Promise.resolve(captured.message?.({}, 'hello'));
      expect(errs.some(e => e.includes('open-boom'))).toBe(true);
      expect(errs.some(e => e.includes('msg-boom'))).toBe(true);
    } finally {
      console.error = originalErr;
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('delegates publish and upgrade to the underlying Bun server', () => {
    const originalServe = Bun.serve;
    const publishCalls: Array<{ channel: string; msg: string }> = [];
    const upgradeCalls: Array<{ req: Request; options: { data: unknown } }> = [];

    Object.assign(Bun, {
      serve() {
        return {
          port: undefined,
          stop() {
            return undefined;
          },
          publish(channel: string, msg: string) {
            publishCalls.push({ channel, msg });
          },
          upgrade(req: Request, options: { data: unknown }) {
            upgradeCalls.push({ req, options });
            return true;
          },
        };
      },
    });

    try {
      const runtime = bunRuntime();
      const server = runtime.server.listen({
        port: 4310,
        fetch() {
          return new Response('ok');
        },
      });
      const request = new Request('http://localhost/ws');
      const upgradeOptions = { data: { userId: 'user-1' } };

      expect(server.port).toBe(4310);
      expect(server.upgrade(request, upgradeOptions)).toBe(true);
      server.publish('room:alpha', 'hello');

      expect(upgradeCalls).toEqual([{ req: request, options: upgradeOptions }]);
      expect(publishCalls).toEqual([{ channel: 'room:alpha', msg: 'hello' }]);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });
});
