import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-node-lifecycle-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-node lifecycle — multiple instances', () => {
  test('creates two independent runtimes', () => {
    const rt1 = nodeRuntime();
    const rt2 = nodeRuntime();

    expect(rt1).toBeDefined();
    expect(rt2).toBeDefined();
    expect(typeof rt1.password.hash).toBe('function');
    expect(typeof rt2.password.hash).toBe('function');
  });

  test('creates runtime with options', () => {
    const rt = nodeRuntime({ wsUpgradeTimeoutMs: 5000 });
    expect(rt).toBeDefined();
    expect(typeof rt.server.listen).toBe('function');
  });

  test('creates runtime with empty options', () => {
    const rt = nodeRuntime({});
    expect(rt).toBeDefined();
    expect(typeof rt.password.hash).toBe('function');
  });

  test('runtime satisfies SlingshotRuntime shape', () => {
    const rt = nodeRuntime();
    expect(typeof rt.password.hash).toBe('function');
    expect(typeof rt.password.verify).toBe('function');
    expect(typeof rt.sqlite.open).toBe('function');
    expect(typeof rt.server.listen).toBe('function');
    expect(typeof rt.fs.write).toBe('function');
    expect(typeof rt.fs.readFile).toBe('function');
    expect(typeof rt.fs.exists).toBe('function');
    expect(typeof rt.glob.scan).toBe('function');
    expect(typeof rt.readFile).toBe('function');
    expect(rt.supportsAsyncLocalStorage).toBe(true);
  });
});

describe('runtime-node lifecycle — filesystem operations', () => {
  test('writes and reads a string file via fs', async () => {
    const runtime = nodeRuntime();
    const filePath = join(tempDir, 'lifecycle.txt');
    await runtime.fs.write(filePath, 'lifecycle-content');
    const bytes = await runtime.fs.readFile(filePath);
    expect(new TextDecoder().decode(bytes!)).toBe('lifecycle-content');
  });

  test('readFile helper returns content for existing file', async () => {
    const runtime = nodeRuntime();
    const filePath = join(tempDir, 'helper.txt');
    await runtime.fs.write(filePath, 'helper-data');
    expect(await runtime.readFile(filePath)).toBe('helper-data');
  });

  test('readFile helper returns null for missing file', async () => {
    const runtime = nodeRuntime();
    expect(await runtime.readFile(join(tempDir, 'missing.txt'))).toBeNull();
  });

  test('glob scan with cwd option', async () => {
    const runtime = nodeRuntime();
    await writeFile(join(tempDir, 'alpha.ts'), '');
    await writeFile(join(tempDir, 'beta.ts'), '');

    const matches = await runtime.glob.scan('*.ts', { cwd: tempDir });
    expect(matches).toHaveLength(2);
  });
});

describe('runtime-node lifecycle — server operations', () => {
  test('server.listen returns an instance with a port', async () => {
    const runtime = nodeRuntime();
    const server = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('port-test'),
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.text()).toBe('port-test');
    } finally {
      await server.stop(true);
    }
  });

  test('server can be stopped and restarted', async () => {
    const runtime = nodeRuntime();
    const s1 = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('first'),
    });
    await s1.stop(true);

    const s2 = await runtime.server.listen({
      port: 0,
      fetch: () => new Response('second'),
    });

    try {
      const res = await fetch(`http://127.0.0.1:${s2.port}/`);
      expect(await res.text()).toBe('second');
    } finally {
      await s2.stop(true);
    }
  });
});
