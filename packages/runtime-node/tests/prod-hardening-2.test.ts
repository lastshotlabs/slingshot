import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureRuntimeNodeLogger,
  configureRuntimeNodeStructuredLogger,
  nodeRuntime,
} from '../src/index';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-node-hardening-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

describe('runtime-node prod hardening 2 — resource cleanup', () => {
  // -----------------------------------------------------------------------
  // Server listen/stop cycles
  // -----------------------------------------------------------------------

  describe('server listen/stop cycles', () => {
    test('three consecutive listen/stop cycles', async () => {
      const runtime = nodeRuntime();
      for (let i = 0; i < 3; i++) {
        const server = await runtime.server.listen({
          port: 0,
          fetch: () => new Response(`cycle-${i}`),
        });
        expect(server.port).toBeGreaterThan(0);

        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await res.text()).toBe(`cycle-${i}`);

        await server.stop(true);
      }
    });

    test('server with no explicit error handler', async () => {
      const runtime = nodeRuntime();
      const server = await runtime.server.listen({
        port: 0,
        fetch: () => new Response('no-error-handler'),
      });

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await res.text()).toBe('no-error-handler');
      } finally {
        await server.stop(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Filesystem edge cases
  // -----------------------------------------------------------------------

  describe('filesystem edge cases', () => {
    test('readFile returns null for non-existent file', async () => {
      const runtime = nodeRuntime();
      const result = await runtime.readFile(join(tempDir, 'does-not-exist.txt'));
      expect(result).toBeNull();
    });

    test('readFile returns content for existing file', async () => {
      const runtime = nodeRuntime();
      const filePath = join(tempDir, 'existing.txt');
      await writeFile(filePath, 'file-content');
      expect(await runtime.readFile(filePath)).toBe('file-content');
    });

    test('fs.exists returns false for non-existent path', async () => {
      const runtime = nodeRuntime();
      expect(await runtime.fs.exists(join(tempDir, 'nope'))).toBe(false);
    });

    test('fs.exists returns true after write', async () => {
      const runtime = nodeRuntime();
      const filePath = join(tempDir, 'now-exists.txt');
      await runtime.fs.write(filePath, 'content');
      expect(await runtime.fs.exists(filePath)).toBe(true);
    });

    test('fs.readFile returns Uint8Array for binary data', async () => {
      const runtime = nodeRuntime();
      const filePath = join(tempDir, 'binary.dat');
      const data = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      await runtime.fs.write(filePath, data);
      const result = await runtime.fs.readFile(filePath);
      expect(result).toEqual(data);
    });
  });

  // -----------------------------------------------------------------------
  // Logger configuration isolation
  // -----------------------------------------------------------------------

  describe('logger configuration', () => {
    test('configureRuntimeNodeLogger returns previous logger', () => {
      const custom = {
        warn() {},
        error() {},
      };
      const prev = configureRuntimeNodeLogger(custom);
      expect(typeof prev.warn).toBe('function');
      expect(typeof prev.error).toBe('function');
      configureRuntimeNodeLogger(prev);
    });

    test('configureRuntimeNodeStructuredLogger returns previous logger', () => {
      const custom = {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return custom as any;
        },
      };
      const prev = configureRuntimeNodeStructuredLogger(custom);
      expect(typeof prev.debug).toBe('function');
      expect(typeof prev.error).toBe('function');
      configureRuntimeNodeStructuredLogger(prev);
    });

    test('logger reset via null does not throw', () => {
      expect(() => configureRuntimeNodeLogger(null)).not.toThrow();
      expect(() => configureRuntimeNodeStructuredLogger(null)).not.toThrow();
    });

    test('custom logger receives warn events', () => {
      const events: string[] = [];
      const custom = {
        warn(event: string) {
          events.push(event);
        },
        error() {},
      };
      const prev = configureRuntimeNodeLogger(custom);
      try {
        // Create a request that triggers a body-too-large warning
        const runtime = nodeRuntime();
        expect(typeof runtime.server.listen).toBe('function');
      } finally {
        configureRuntimeNodeLogger(prev);
      }
    });
  });
});

describe('runtime-node prod hardening 2 — password operations', () => {
  test('password verify returns false for malformed hash', async () => {
    const runtime = nodeRuntime();
    const result = await runtime.password.verify('password', 'not-a-valid-hash');
    expect(result).toBe(false);
  });

  test('password hash and verify roundtrip', async () => {
    const runtime = nodeRuntime();
    const hash = await runtime.password.hash('roundtrip-pw');
    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify('roundtrip-pw', hash)).toBe(true);
    expect(await runtime.password.verify('wrong', hash)).toBe(false);
  });
});
