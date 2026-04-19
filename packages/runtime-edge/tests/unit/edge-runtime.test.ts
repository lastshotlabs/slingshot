// packages/runtime-edge/tests/unit/edge-runtime.test.ts
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('edgeRuntime()', () => {
  describe('factory', () => {
    it('returns a frozen object', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime)).toBe(true);
    });

    it('sets supportsAsyncLocalStorage to false', () => {
      const runtime = edgeRuntime();
      expect(runtime.supportsAsyncLocalStorage).toBe(false);
    });

    it('satisfies SlingshotRuntime shape (structural)', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.password.hash).toBe('function');
      expect(typeof runtime.password.verify).toBe('function');
      expect(typeof runtime.readFile).toBe('function');
      expect(typeof runtime.supportsAsyncLocalStorage).toBe('boolean');
    });
  });

  describe('readFile()', () => {
    it('returns null when no fileStore is configured', async () => {
      const runtime = edgeRuntime();
      const result = await runtime.readFile('/some/path');
      expect(result).toBeNull();
    });

    it('delegates to the provided fileStore', async () => {
      const store = new Map<string, string>();
      store.set('/assets/app.js', 'console.log("hello")');

      const runtime = edgeRuntime({
        fileStore: async path => store.get(path) ?? null,
      });

      const result = await runtime.readFile('/assets/app.js');
      expect(result).toBe('console.log("hello")');
    });

    it('returns null for unknown paths from fileStore', async () => {
      const runtime = edgeRuntime({
        fileStore: async () => null,
      });
      expect(await runtime.readFile('/nonexistent')).toBeNull();
    });
  });

  describe('password hashing (Web Crypto)', () => {
    it('hashes a password without throwing', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('mysecret');
      expect(typeof hash).toBe('string');
      expect(hash).toContain(':');
    });

    it('verifies a correct password', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('correct');
      const ok = await runtime.password.verify('correct', hash);
      expect(ok).toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('correct');
      const ok = await runtime.password.verify('wrong', hash);
      expect(ok).toBe(false);
    });

    it('returns false for a malformed hash', async () => {
      const runtime = edgeRuntime();
      const ok = await runtime.password.verify('password', 'not-a-valid-hash');
      expect(ok).toBe(false);
    });

    it('each hash call produces a unique output (random salt)', async () => {
      const runtime = edgeRuntime();
      const hash1 = await runtime.password.hash('same');
      const hash2 = await runtime.password.hash('same');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('custom password hashing', () => {
    it('uses the provided hashPassword function', async () => {
      let called = false;
      const runtime = edgeRuntime({
        hashPassword: async plain => {
          called = true;
          return `custom:${plain}`;
        },
        verifyPassword: async (plain, hash) => hash === `custom:${plain}`,
      });

      const hash = await runtime.password.hash('test');
      expect(called).toBe(true);
      expect(hash).toBe('custom:test');
    });

    it('uses the provided verifyPassword function', async () => {
      const runtime = edgeRuntime({
        hashPassword: async plain => `custom:${plain}`,
        verifyPassword: async (plain, hash) => hash === `custom:${plain}`,
      });

      const hash = await runtime.password.hash('test');
      expect(await runtime.password.verify('test', hash)).toBe(true);
      expect(await runtime.password.verify('wrong', hash)).toBe(false);
    });
  });

  describe('stubs', () => {
    it('sqlite.open() throws with a clear message', () => {
      const runtime = edgeRuntime();
      expect(() => runtime.sqlite.open('/some/path')).toThrow('[runtime-edge]');
    });

    it('server.listen() throws with a clear message', () => {
      const runtime = edgeRuntime();
      const empty = {};
      expect(() => runtime.server.listen(empty as never)).toThrow('[runtime-edge]');
    });

    it('fs.write() rejects with a clear message', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.fs.write('/some/path', 'data')).rejects.toThrow('[runtime-edge]');
    });

    it('fs.readFile() returns null (no filesystem)', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.fs.readFile('/some/path')).toBeNull();
    });

    it('fs.exists() returns false (no filesystem)', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.fs.exists('/some/path')).toBe(false);
    });

    it('glob.scan() rejects with a clear message', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.glob.scan('**/*.ts')).rejects.toThrow('[runtime-edge]');
    });
  });
});
