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

  test('delegates publish and upgrade to the underlying Bun server', () => {
    const originalServe = Bun.serve;
    const publishCalls: Array<{ channel: string; msg: string }> = [];
    const upgradeCalls: Array<{ req: Request; options: { data: unknown } }> = [];

    Object.assign(Bun, {
      serve(options: Parameters<typeof Bun.serve>[0]) {
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
