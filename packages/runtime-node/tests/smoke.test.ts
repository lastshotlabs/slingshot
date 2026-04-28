import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

// SQLite (better-sqlite3) and WebSocket (upgrade() flow) tests live in
// tests/node-runtime/nodeRuntime.test.ts and run under vitest (Node.js).
// This file covers capabilities that work correctly under bun:test.

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-runtime-node-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-node smoke', () => {
  // ---------------------------------------------------------------------------
  // Password
  // ---------------------------------------------------------------------------

  test('hashes and verifies passwords', async () => {
    const runtime = nodeRuntime();
    const hash = await runtime.password.hash('hunter2');

    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify('hunter2', hash)).toBe(true);
    expect(await runtime.password.verify('wrong', hash)).toBe(false);
  });

  test('each hash call produces a unique output (random salt)', async () => {
    const runtime = nodeRuntime();
    const hash1 = await runtime.password.hash('same');
    const hash2 = await runtime.password.hash('same');
    expect(hash1).not.toBe(hash2);
  });

  test('verify returns false for a malformed hash', async () => {
    const runtime = nodeRuntime();
    const ok = await runtime.password.verify('password', 'not-a-valid-hash');
    expect(ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Filesystem
  // ---------------------------------------------------------------------------

  test('reads and writes files and returns null for missing runtime reads', async () => {
    const runtime = nodeRuntime();
    const filePath = join(tempDir, 'hello.txt');

    await runtime.fs.write(filePath, 'hello world');
    expect(await runtime.fs.exists(filePath)).toBe(true);

    const bytes = await runtime.fs.readFile(filePath);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('hello world');
    expect(await runtime.readFile(filePath)).toBe('hello world');
    expect(await runtime.readFile(join(tempDir, 'missing.txt'))).toBeNull();
  });

  test('runtime.readFile rethrows non-ENOENT errors', async () => {
    const runtime = nodeRuntime();
    const readSpy = spyOn(fsPromises, 'readFile').mockImplementation(async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    try {
      await expect(runtime.readFile(join(tempDir, 'forbidden.txt'))).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  test('fs.readFile returns null for ENOENT', async () => {
    const runtime = nodeRuntime();
    expect(await runtime.fs.readFile(join(tempDir, 'nonexistent.bin'))).toBeNull();
  });

  test('fs.exists returns false for missing files', async () => {
    const runtime = nodeRuntime();
    expect(await runtime.fs.exists(join(tempDir, 'nope'))).toBe(false);
  });

  test('fs.write handles Uint8Array data', async () => {
    const runtime = nodeRuntime();
    const filePath = join(tempDir, 'binary.bin');
    const data = new Uint8Array([0x48, 0x49]);
    await runtime.fs.write(filePath, data);
    const bytes = await runtime.fs.readFile(filePath);
    expect(bytes).toEqual(new Uint8Array([0x48, 0x49]));
  });

  // ---------------------------------------------------------------------------
  // Glob
  // ---------------------------------------------------------------------------

  test('scans files with glob support', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'a.ts'), '');
    await writeFile(join(tempDir, 'b.js'), '');
    await mkdir(join(tempDir, 'nested'));
    await writeFile(join(tempDir, 'nested', 'c.ts'), '');

    const matches = await runtime.glob.scan('**/*.ts', { cwd: tempDir });
    expect(matches.map(match => match.replace(/\\/g, '/')).sort()).toEqual(['a.ts', 'nested/c.ts']);
  });

  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

  test('wraps @hono/node-server with a usable server instance facade', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
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
      await server.stop(true);
    }
  });

  test('stop() resolves cleanly', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('bye'),
    });

    expect(server.port).toBeGreaterThan(0);
    await server.stop();
  });

  test('stop(true) closes active connections immediately', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('ok'),
    });

    // Make a request to establish a connection
    await fetch(`http://127.0.0.1:${server.port}`);
    // stop(true) should resolve without waiting for keep-alive timeout
    await server.stop(true);
  });

  // ---------------------------------------------------------------------------
  // Runtime shape
  // ---------------------------------------------------------------------------

  test('sets supportsAsyncLocalStorage to true', () => {
    const runtime = nodeRuntime();
    expect(runtime.supportsAsyncLocalStorage).toBe(true);
  });

  test('satisfies SlingshotRuntime shape (structural)', () => {
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

  // ---------------------------------------------------------------------------
  // Error callback
  // ---------------------------------------------------------------------------

  test('server error callback fires when fetch handler throws', async () => {
    const runtime = nodeRuntime();
    const errors: Error[] = [];
    const instance = await runtime.server.listen({
      port: 0,
      fetch() {
        throw new Error('boom');
      },
      error(err) {
        errors.push(err);
        return new Response('error-caught', { status: 500 });
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('error-caught');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('boom');
    } finally {
      await instance.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // WAL mode
  // ---------------------------------------------------------------------------

  // better-sqlite3 is a native Node.js addon — it is not supported in Bun.
  // This test runs only in a Node.js context. When executed under Bun the test
  // is skipped rather than failing, matching the behaviour of the other SQLite
  // tests in tests/node-runtime/nodeRuntime.test.ts.
  test.skipIf(typeof Bun !== 'undefined')('sqlite WAL mode is enabled', () => {
    const runtime = nodeRuntime();
    const db = runtime.sqlite.open(join(tempDir, 'wal.db'));
    try {
      type JournalRow = { journal_mode: string };
      const rows = db.query<JournalRow>('PRAGMA journal_mode').all();
      expect(rows[0]?.journal_mode).toBe('wal');
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // TLS / HTTPS server
  // ---------------------------------------------------------------------------

  test('server starts with TLS when key and cert are provided', async () => {
    // Generate a temporary self-signed certificate using the system openssl binary.
    // The generated files are placed in tempDir so they are cleaned up after the test.
    let opensslAvailable = true;
    try {
      execSync('openssl version', { stdio: 'ignore' });
    } catch {
      opensslAvailable = false;
    }

    if (!opensslAvailable) {
      // openssl not available — skip silently.
      return;
    }

    const keyPath = join(tempDir, 'tls.key');
    const certPath = join(tempDir, 'tls.crt');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
      { stdio: 'ignore' },
    );

    const { readFile } = await import('node:fs/promises');
    const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);

    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      tls: { key, cert },
      fetch() {
        return new Response('tls-ok');
      },
    });

    try {
      // TLS server binds on a valid ephemeral port
      expect(instance.port).toBeGreaterThan(0);
    } finally {
      await instance.stop();
    }
  });
});
