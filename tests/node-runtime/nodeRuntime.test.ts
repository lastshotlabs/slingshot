/**
 * Node.js runtime adapter verification tests.
 * Runs under vitest (Node.js process) to prove @lastshotlabs/slingshot-runtime-node
 * works correctly against real implementations (better-sqlite3, argon2,
 * fast-glob, @hono/node-server, ws).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { __runtimeNodeInternals, nodeRuntime } from '../../packages/runtime-node/src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'slingshot-node-runtime-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Create a promise that resolves when a condition is met. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openRawSocket(
  port: number,
  headers: string[],
): Promise<import('node:net').Socket> {
  const net = await import('node:net');
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers.join('\r\n')}\r\n\r\n`);
  return socket;
}

function waitForSocketEnd(socket: import('node:net').Socket): Promise<void> {
  return new Promise(resolve => {
    const done = () => resolve();
    socket.once('close', done);
    socket.once('end', done);
    socket.once('error', done);
  });
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

describe('WebSocket payload normalization helpers', () => {
  it('returns strings unchanged', () => {
    expect(__runtimeNodeInternals.stringifyWsPayload('plain-text')).toBe('plain-text');
  });

  it('converts typed-array views into Buffer slices', () => {
    const bytes = new Uint8Array([65, 66, 67, 68]);
    const view = new Uint8Array(bytes.buffer, 1, 2);
    const chunk = __runtimeNodeInternals.toBufferChunk(view);
    expect(chunk?.toString()).toBe('BC');
  });

  it('stringifies chunk arrays composed of mixed supported payload types', () => {
    const value = __runtimeNodeInternals.stringifyWsPayload([
      'A',
      new Uint8Array([66]),
      new Uint8Array([67]).buffer,
    ]);
    expect(value).toBe('ABC');
  });

  it('throws for unsupported chunk-array entries', () => {
    expect(() =>
      __runtimeNodeInternals.stringifyWsPayload(['ok', { bad: true }]),
    ).toThrowError('Unsupported WebSocket message chunk type');
  });

  it('throws for unsupported top-level payloads', () => {
    expect(() => __runtimeNodeInternals.stringifyWsPayload({ nope: true })).toThrowError(
      'Unsupported WebSocket message payload type',
    );
  });
});

describe('RuntimePassword (argon2)', () => {
  const runtime = nodeRuntime();

  it('hashes and verifies a correct password', async () => {
    const hash = await runtime.password.hash('hunter2');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(20);
    expect(await runtime.password.verify('hunter2', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await runtime.password.hash('hunter2');
    expect(await runtime.password.verify('wrong', hash)).toBe(false);
  });

  it('produces unique hashes for the same input (random salt)', async () => {
    const hash1 = await runtime.password.hash('same');
    const hash2 = await runtime.password.hash('same');
    expect(hash1).not.toBe(hash2);
  });

  it('returns false for a malformed hash', async () => {
    expect(await runtime.password.verify('password', 'not-a-valid-hash')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

describe('RuntimeSqliteDatabase (better-sqlite3)', () => {
  it('runs migrations and performs CRUD', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'test.db'));

    db.run('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run('INSERT INTO items VALUES (?, ?)', 'a', 'hello');
    db.run('INSERT INTO items VALUES (?, ?)', 'b', 'world');

    const row = db
      .query<{ id: string; value: string }>('SELECT * FROM items WHERE id = ?')
      .get('a');
    expect(row).toEqual({ id: 'a', value: 'hello' });

    const all = db.query<{ id: string; value: string }>('SELECT * FROM items ORDER BY id').all();
    expect(all).toHaveLength(2);
    expect(all[0].value).toBe('hello');
    expect(all[1].value).toBe('world');

    db.run('UPDATE items SET value = ? WHERE id = ?', 'updated', 'a');
    const updated = db.query<{ value: string }>('SELECT value FROM items WHERE id = ?').get('a');
    expect(updated?.value).toBe('updated');

    db.close();
  });

  it('prepare() returns change count', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'prepare-test.db'));

    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t VALUES (?, ?)', 'x', 'old');

    const stmt = db.prepare('UPDATE t SET v = ? WHERE id = ? AND v = ?');
    const result = stmt.run('new', 'x', 'old');
    expect(result.changes).toBe(1);

    // No match — changes should be 0
    const miss = stmt.run('new2', 'x', 'old'); // 'old' no longer matches
    expect(miss.changes).toBe(0);

    db.close();
  });

  it('transaction() wraps operations atomically', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'tx-test.db'));

    db.run('CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL)');
    db.run('INSERT INTO accounts VALUES (?, ?)', 'alice', 100);
    db.run('INSERT INTO accounts VALUES (?, ?)', 'bob', 0);

    const transfer = db.transaction(() => {
      db.run('UPDATE accounts SET balance = balance - 50 WHERE id = ?', 'alice');
      db.run('UPDATE accounts SET balance = balance + 50 WHERE id = ?', 'bob');
    });
    transfer();

    const alice = db
      .query<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?')
      .get('alice');
    const bob = db
      .query<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?')
      .get('bob');
    expect(alice?.balance).toBe(50);
    expect(bob?.balance).toBe(50);

    db.close();
  });

  it('enables WAL mode', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'wal.db'));
    const row = db.query<{ journal_mode: string }>('PRAGMA journal_mode').get();
    expect(row?.journal_mode).toBe('wal');
    db.close();
  });

  it('query().get returns null for no matching rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'empty.db'));
    db.run('CREATE TABLE items (id TEXT PRIMARY KEY)');
    expect(db.query('SELECT * FROM items WHERE id = ?').get('nope')).toBeNull();
    db.close();
  });

  it('query().run executes DML without returning rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'query-run.db'));

    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t VALUES (?, ?)', 'a', 'one');

    const q = db.query('UPDATE t SET v = ? WHERE id = ?');
    q.run('two', 'a');

    const row = db.query<{ v: string }>('SELECT v FROM t WHERE id = ?').get('a');
    expect(row?.v).toBe('two');

    db.close();
  });

  it('prepare().get returns null for no matching rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'empty2.db'));
    db.run('CREATE TABLE items (id TEXT PRIMARY KEY)');
    expect(db.prepare('SELECT * FROM items WHERE id = ?').get('nope')).toBeNull();
    db.close();
  });

  it('prepare().all returns all matching rows', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tmpDir, 'prepare-all.db'));
    db.run('CREATE TABLE items (id TEXT PRIMARY KEY, category TEXT NOT NULL)');
    db.run('INSERT INTO items VALUES (?, ?)', 'a', 'books');
    db.run('INSERT INTO items VALUES (?, ?)', 'b', 'books');
    db.run('INSERT INTO items VALUES (?, ?)', 'c', 'games');

    const rows = db
      .prepare<{ id: string }>('SELECT id FROM items WHERE category = ? ORDER BY id')
      .all('books');
    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

describe('RuntimeFs (node:fs)', () => {
  it('writes and reads a file', async () => {
    const runtime = nodeRuntime();
    const path = join(tmpDir, 'hello.txt');

    await runtime.fs.write(path, 'hello world');
    const data = await runtime.fs.readFile(path);
    expect(data).not.toBeNull();
    expect(new TextDecoder().decode(data!)).toBe('hello world');
  });

  it('writes and reads binary data', async () => {
    const runtime = nodeRuntime();
    const path = join(tmpDir, 'bytes.bin');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await runtime.fs.write(path, bytes);
    const data = await runtime.fs.readFile(path);
    expect(data).not.toBeNull();
    expect(Array.from(data!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null for a missing file', async () => {
    const runtime = nodeRuntime();
    const data = await runtime.fs.readFile(join(tmpDir, 'missing.txt'));
    expect(data).toBeNull();
  });

  it('exists() detects presence', async () => {
    const runtime = nodeRuntime();
    const path = join(tmpDir, 'exist.txt');

    expect(await runtime.fs.exists(path)).toBe(false);
    await runtime.fs.write(path, 'data');
    expect(await runtime.fs.exists(path)).toBe(true);
  });

  it('readFile (top-level) returns UTF-8 string', async () => {
    const runtime = nodeRuntime();
    const path = join(tmpDir, 'utf8.txt');
    await runtime.fs.write(path, 'hello world');
    expect(await runtime.readFile(path)).toBe('hello world');
  });

  it('readFile (top-level) returns null for missing file', async () => {
    const runtime = nodeRuntime();
    expect(await runtime.readFile(join(tmpDir, 'nope.txt'))).toBeNull();
  });

  it('rethrows non-ENOENT readFile errors', async () => {
    const runtime = nodeRuntime();
    await expect(runtime.fs.readFile(tmpDir)).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

describe('RuntimeGlob (fast-glob)', () => {
  it('scans matching files', async () => {
    const runtime = nodeRuntime();

    await writeFile(join(tmpDir, 'a.ts'), '');
    await writeFile(join(tmpDir, 'b.ts'), '');
    await writeFile(join(tmpDir, 'c.js'), '');
    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'sub', 'd.ts'), '');

    const results = await runtime.glob.scan('**/*.ts', { cwd: tmpDir });
    const sorted: string[] = Array.isArray(results) ? [...results].sort() : [];
    if (!Array.isArray(results)) {
      for await (const f of results) sorted.push(f);
      sorted.sort();
    }
    expect(sorted).toContain('a.ts');
    expect(sorted).toContain('b.ts');
    expect(sorted).toContain('sub/d.ts');
    expect(sorted).not.toContain('c.js');
  });

  it('returns empty array when no matches', async () => {
    const runtime = nodeRuntime();
    const results = await runtime.glob.scan('**/*.never', { cwd: tmpDir });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

describe('RuntimeServerFactory (@hono/node-server)', () => {
  it('starts on ephemeral port and serves HTTP requests', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}`);
      expect(await res.text()).toBe('ok');
    } finally {
      await server.stop(true);
    }
  });

  it('routes different paths', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/hello') return new Response('world');
        if (url.pathname === '/json') {
          return Response.json({ ok: true });
        }
        return new Response('not found', { status: 404 });
      },
    });

    try {
      const r1 = await fetch(`http://127.0.0.1:${server.port}/hello`);
      expect(await r1.text()).toBe('world');

      const r2 = await fetch(`http://127.0.0.1:${server.port}/json`);
      expect(await r2.json()).toEqual({ ok: true });

      const r3 = await fetch(`http://127.0.0.1:${server.port}/missing`);
      expect(r3.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  it('stop() resolves cleanly', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('bye'),
    });
    expect(server.port).toBeGreaterThan(0);
    await server.stop();
  });

  it('calls opts.error when the fetch handler rejects (async)', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      async fetch() {
        throw new Error('async boom');
      },
      error(err) {
        return new Response(`caught: ${err.message}`, { status: 500 });
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught: async boom');
    } finally {
      await server.stop(true);
    }
  });

  it('calls opts.error when the fetch handler throws', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        throw new Error('boom');
      },
      error(err) {
        return new Response(`caught: ${err.message}`, { status: 500 });
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught: boom');
    } finally {
      await server.stop(true);
    }
  });

  it('wraps non-Error throws via opts.error', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        throw 'string-error'; // non-Error value
      },
      error(err) {
        return new Response(`caught: ${err.message}`, { status: 500 });
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught: string-error');
    } finally {
      await server.stop(true);
    }
  });

  it('stop(true) force-closes active connections', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });

    // Establish a connection then force-close
    await fetch(`http://127.0.0.1:${server.port}`);
    await server.stop(true);
  });
});

// ---------------------------------------------------------------------------
// WebSocket — upgrade() + lifecycle
// ---------------------------------------------------------------------------

describe('WebSocket (ws)', () => {
  it('supports upgrade() from inside the fetch handler', async () => {
    const runtime = nodeRuntime();
    const messages: string[] = [];
    const opened = deferred();
    const received = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          const upgraded = server.upgrade!(req, { data: { userId: 'u1' } });
          if (upgraded) return new Response(null);
          return new Response('Upgrade failed', { status: 400 });
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          expect(ws.data).toEqual({ userId: 'u1' });
          ws.send('hello from server');
          opened.resolve();
        },
        message(_ws, msg) {
          messages.push(String(msg));
          received.resolve();
        },
        close() {},
      },
    });

    try {
      const clientMessages: string[] = [];
      const clientReceived = deferred();

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('message', (data: Buffer) => {
        clientMessages.push(data.toString());
        clientReceived.resolve();
      });
      ws.on('open', () => {
        ws.send('hello from client');
      });

      await opened.promise;
      await received.promise;
      await clientReceived.promise;

      expect(messages).toEqual(['hello from client']);
      expect(clientMessages).toEqual(['hello from server']);

      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('defaults listen() to port 3000 and tolerates all createServer callback shapes', async () => {
    const firstArgListener = vi.fn();
    const secondArgListener = vi.fn();
    const originalResponse = global.Response;

    vi.doMock('@hono/node-server', () => ({
      serve(
        options: {
          port: number;
          createServer: (...args: unknown[]) => unknown;
        },
        onListen: (info: { port: number }) => void,
      ) {
        expect(options.port).toBe(3000);
        options.createServer(firstArgListener);
        options.createServer({}, secondArgListener);
        options.createServer({});
        onListen({ port: 3000 });
      },
    }));

    try {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        fetch: () => new originalResponse('ok'),
      });
      expect(server.port).toBe(3000);
    } finally {
      vi.doUnmock('@hono/node-server');
    }
  });

  it('delivers custom data attached at upgrade time', async () => {
    const runtime = nodeRuntime();
    const opened = deferred<unknown>();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: { role: 'admin', id: 42 } });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          opened.resolve(ws.data);
        },
        message() {},
        close() {},
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      const data = await opened.promise;
      expect(data).toEqual({ role: 'admin', id: 42 });
      await clientOpen.promise;
      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('publish() broadcasts to all channel subscribers', async () => {
    const runtime = nodeRuntime();
    let connCount = 0;
    const allConnected = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.subscribe('room1');
          connCount++;
          if (connCount >= 2) allConnected.resolve();
        },
        message() {},
        close() {},
      },
    });

    try {
      const received1: string[] = [];
      const received2: string[] = [];
      const msg1 = deferred();
      const msg2 = deferred();

      const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws1.on('message', (data: Buffer) => {
        received1.push(data.toString());
        msg1.resolve();
      });

      const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws2.on('message', (data: Buffer) => {
        received2.push(data.toString());
        msg2.resolve();
      });

      await allConnected.promise;

      server.publish!('room1', 'broadcast');
      await msg1.promise;
      await msg2.promise;

      expect(received1).toEqual(['broadcast']);
      expect(received2).toEqual(['broadcast']);

      ws1.close();
      ws2.close();
    } finally {
      await server.stop(true);
    }
  });

  it('unsubscribe() stops delivery', async () => {
    const runtime = nodeRuntime();
    const opened = deferred();

    let serverWs: { unsubscribe: (ch: string) => void } | undefined;

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.subscribe('ch');
          serverWs = ws;
          opened.resolve();
        },
        message() {},
        close() {},
      },
    });

    try {
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('message', (data: Buffer) => {
        received.push(data.toString());
      });

      await opened.promise;

      // First publish should arrive
      server.publish!('ch', 'msg1');
      // Wait for delivery
      await new Promise(r => setTimeout(r, 50));
      expect(received).toEqual(['msg1']);

      // Unsubscribe and publish again — should NOT arrive
      serverWs!.unsubscribe('ch');
      server.publish!('ch', 'msg2');
      await new Promise(r => setTimeout(r, 50));
      expect(received).toEqual(['msg1']);

      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('unsubscribe() removes the last subscriber channel immediately', async () => {
    const runtime = nodeRuntime();
    const unsubscribed = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.subscribe('solo');
          ws.unsubscribe('solo');
          unsubscribed.resolve();
        },
        message() {},
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await unsubscribed.promise;
      server.publish!('solo', 'ghost');
      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('cleans up channel subscriptions on close', async () => {
    const runtime = nodeRuntime();
    const opened = deferred();
    const closed = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.subscribe('ephemeral');
          opened.resolve();
        },
        message() {},
        close() {
          closed.resolve();
        },
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      await opened.promise;
      await clientOpen.promise;
      ws.close();
      await closed.promise;

      // Publishing to 'ephemeral' after the only subscriber closed
      // should be a no-op (no crash, no hanging)
      server.publish!('ephemeral', 'ghost');
    } finally {
      await server.stop(true);
    }
  });

  it('normalizes binary WebSocket messages to strings', async () => {
    const runtime = nodeRuntime();
    const messages: string[] = [];
    const received = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message(_ws, msg) {
          messages.push(String(msg));
          received.resolve();
        },
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => {
        // Send binary data — should be stringified by the runtime
        ws.send(Buffer.from([65, 66]));
      });

      await received.promise;
      expect(messages).toEqual(['AB']);

      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('handles ArrayBuffer WebSocket messages', async () => {
    const runtime = nodeRuntime();
    const messages: string[] = [];
    const received = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message(_ws, msg) {
          messages.push(String(msg));
          received.resolve();
        },
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => {
        // Send an ArrayBuffer
        const buf = new ArrayBuffer(2);
        const view = new Uint8Array(buf);
        view[0] = 67; // 'C'
        view[1] = 68; // 'D'
        ws.send(buf);
      });

      await received.promise;
      expect(messages).toEqual(['CD']);
      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('passes close code and reason to the handler', async () => {
    const runtime = nodeRuntime();
    const closed = deferred<{ code: number; reason: string }>();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close(_ws, code, reason) {
          closed.resolve({ code, reason });
        },
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      await clientOpen.promise;
      ws.close(1000, 'bye');

      const { code, reason } = await closed.promise;
      expect(code).toBe(1000);
      expect(reason).toBe('bye');
    } finally {
      await server.stop(true);
    }
  });

  it('upgrade() returns false when called without a pending upgrade', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      // Craft a fake request with no matching pending upgrade
      const fakeReq = new Request('http://localhost/ws', {
        headers: { 'sec-websocket-key': 'bogus-key' },
      });
      expect(server.upgrade!(fakeReq, { data: {} })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('fires pong handler when client responds to server ping', async () => {
    const runtime = nodeRuntime();
    const ponged = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.ping();
        },
        message() {},
        close() {},
        pong() {
          ponged.resolve();
        },
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      await clientOpen.promise;
      await ponged.promise;
      ws.close();
    } finally {
      await server.stop(true);
    }
  });

  it('server can close a WebSocket connection with code and reason', async () => {
    const runtime = nodeRuntime();
    const opened = deferred();
    const clientClosed = deferred<{ code: number; reason: string }>();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          opened.resolve();
          // Close from server side after a short delay
          setTimeout(() => ws.close(4000, 'server-initiated'), 20);
        },
        message() {},
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('close', (code: number, reason: Buffer) => {
        clientClosed.resolve({ code, reason: reason.toString() });
      });

      await opened.promise;
      const { code, reason } = await clientClosed.promise;
      expect(code).toBe(4000);
      expect(reason).toBe('server-initiated');
    } finally {
      await server.stop(true);
    }
  });

  it('publish() skips WebSockets that are not in OPEN state', async () => {
    const runtime = nodeRuntime();
    const opened = deferred();
    const serverClosed = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.subscribe('ch');
          opened.resolve();
        },
        message() {},
        close() {
          serverClosed.resolve();
        },
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      await opened.promise;
      await clientOpen.promise;

      // Close the client — the server-side ws goes to CLOSING/CLOSED state
      ws.close();
      await serverClosed.promise;

      // Publishing after the subscriber closed should be a no-op (no crash)
      server.publish!('ch', 'should-not-crash');
    } finally {
      await server.stop(true);
    }
  });

  it('publish() skips a socket that is already closing but not yet removed from the channel', async () => {
    const runtime = nodeRuntime();
    const opened = deferred();
    const clientClosed = deferred();
    let serverWs:
      | {
          subscribe: (channel: string) => void;
          close: (code?: number, reason?: string) => void;
        }
      | undefined;

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          serverWs = ws;
          ws.subscribe('closing');
          opened.resolve();
        },
        message() {},
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('close', () => clientClosed.resolve());
      await opened.promise;

      serverWs!.close(1000, 'closing');
      server.publish!('closing', 'ignored');

      await clientClosed.promise;
    } finally {
      await server.stop(true);
    }
  });

  it('stop() cleans up pending upgrade requests', async () => {
    const runtime = nodeRuntime();
    const fetchCalled = deferred();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          // Intentionally do NOT call upgrade() — leave request pending
          fetchCalled.resolve();
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      // Initiate a WebSocket connection (will leave a pending upgrade)
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('error', () => {}); // Suppress client-side errors from forced close
      await fetchCalled.promise;
    } finally {
      // stop() should clean up pending upgrades without hanging
      await server.stop(true);
    }
  });

  it('logs and swallows errors from async message handler', async () => {
    const runtime = nodeRuntime();
    const errorLogged = deferred();
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('websocket message handler failed')) {
        errorLogged.resolve();
      }
    };

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        async message() {
          throw new Error('handler-crash');
        },
        close() {},
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => {
        clientOpen.resolve();
        ws.send('trigger');
      });
      await clientOpen.promise;
      await errorLogged.promise;
      ws.close();
    } finally {
      console.error = originalError;
      await server.stop(true);
    }
  });

  it('logs and swallows errors from async open handler', async () => {
    const runtime = nodeRuntime();
    const errorLogged = deferred();
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('websocket open handler failed')) {
        errorLogged.resolve();
      }
    };

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        async open() {
          throw new Error('open-crash');
        },
        message() {},
        close() {},
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('error', () => {}); // suppress
      await errorLogged.promise;
      ws.close();
    } finally {
      console.error = originalError;
      await server.stop(true);
    }
  });

  it('logs and swallows errors from async close handler', async () => {
    const runtime = nodeRuntime();
    const errorLogged = deferred();
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('websocket close handler failed')) {
        errorLogged.resolve();
      }
    };

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        async close() {
          throw new Error('close-crash');
        },
      },
    });

    try {
      const clientOpen = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => clientOpen.resolve());
      await clientOpen.promise;
      ws.close();
      await errorLogged.promise;
    } finally {
      console.error = originalError;
      await server.stop(true);
    }
  });

  it('logs and swallows errors from pong handler', async () => {
    const runtime = nodeRuntime();
    const errorLogged = deferred();
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('websocket pong handler failed')) {
        errorLogged.resolve();
      }
    };

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          ws.ping();
        },
        message() {},
        close() {},
        pong() {
          throw new Error('pong-crash');
        },
      },
    });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('error', () => {});
      await errorLogged.promise;
      ws.close();
    } finally {
      console.error = originalError;
      await server.stop(true);
    }
  });

  it('upgrade() returns false when request has no sec-websocket-key', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      // Request without sec-websocket-key header
      const fakeReq = new Request('http://localhost/ws');
      expect(server.upgrade!(fakeReq, { data: {} })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('destroys malformed raw upgrade requests that omit sec-websocket-key', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      const socket = await openRawSocket(server.port, [
        'Connection: Upgrade',
        'Upgrade: websocket',
      ]);
      await waitForSocketEnd(socket);
    } finally {
      await server.stop(true);
    }
  });

  it('times out pending raw upgrade requests that are never accepted', async () => {
    const runtime = nodeRuntime();
    const realSetTimeout = global.setTimeout;
    const fetchCalled = deferred();
    const setTimeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        return realSetTimeout(handler, timeout === 30_000 ? 5 : timeout, ...args);
      }) as typeof setTimeout);

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          fetchCalled.resolve();
          return new Response(null);
        }
        return new Response('ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      const socket = await openRawSocket(server.port, [
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ]);
      await fetchCalled.promise;
      await waitForSocketEnd(socket);
    } finally {
      setTimeoutSpy.mockRestore();
      await server.stop(true);
    }
  });

  it('upgrade() returns false when no websocket handler is configured', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch() {
        return new Response('ok');
      },
      // No websocket handler
    });

    try {
      const fakeReq = new Request('http://localhost/ws', {
        headers: { 'sec-websocket-key': 'some-key' },
      });
      expect(server.upgrade!(fakeReq, { data: {} })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('HTTP requests still work alongside WebSocket', async () => {
    const runtime = nodeRuntime();

    const server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          server.upgrade!(req, { data: {} });
          return new Response(null);
        }
        return new Response('http ok');
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    try {
      // HTTP request works
      const res = await fetch(`http://127.0.0.1:${server.port}/api`);
      expect(await res.text()).toBe('http ok');

      // WebSocket also works
      const opened = deferred();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on('open', () => opened.resolve());
      await opened.promise;
      ws.close();
    } finally {
      await server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TLS Server
// ---------------------------------------------------------------------------

describe('TLS Server', () => {
  it('starts an HTTPS server when tls key/cert are provided', async () => {
    // Generate self-signed cert for testing
    const { execSync } = await import('node:child_process');
    const keyPath = join(tmpDir, 'key.pem');
    const certPath = join(tmpDir, 'cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=localhost"`,
      { stdio: 'pipe' },
    );

    const { readFile } = await import('node:fs/promises');
    const key = await readFile(keyPath, 'utf8');
    const cert = await readFile(certPath, 'utf8');

    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      tls: { key, cert },
      fetch() {
        return new Response('tls ok');
      },
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      // Use Node's https.get with rejectUnauthorized: false for self-signed cert
      const https = await import('node:https');
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.get(
          `https://127.0.0.1:${server.port}`,
          { rejectUnauthorized: false },
          res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
          },
        );
        req.on('error', reject);
      });
      expect(body).toBe('tls ok');
    } finally {
      await server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime shape
// ---------------------------------------------------------------------------

describe('SlingshotRuntime shape', () => {
  it('sets supportsAsyncLocalStorage to true', () => {
    const runtime = nodeRuntime();
    expect(runtime.supportsAsyncLocalStorage).toBe(true);
  });

  it('exposes all required capabilities', () => {
    const runtime = nodeRuntime();
    expect(typeof runtime.password.hash).toBe('function');
    expect(typeof runtime.password.verify).toBe('function');
    expect(typeof runtime.sqlite.open).toBe('function');
    expect(typeof runtime.server.listen).toBe('function');
    expect(typeof runtime.fs.write).toBe('function');
    expect(typeof runtime.fs.readFile).toBe('function');
    expect(typeof runtime.fs.exists).toBe('function');
    expect(typeof runtime.glob.scan).toBe('function');
    expect(typeof runtime.readFile).toBe('function');
    expect(typeof runtime.supportsAsyncLocalStorage).toBe('boolean');
  });
});
