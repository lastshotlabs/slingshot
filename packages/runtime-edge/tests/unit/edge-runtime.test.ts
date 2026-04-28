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

    it('readFile propagates errors thrown by fileStore', async () => {
      const runtime = edgeRuntime({
        fileStore: async (_path: string) => {
          throw new Error('store-unavailable');
        },
      });
      await expect(runtime.readFile('/any/path')).rejects.toThrow('store-unavailable');
    });

    it('rejects buffered string results that exceed maxFileBytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => 'x'.repeat(2048),
      });
      await expect(runtime.readFile('/big')).rejects.toThrow(/exceeds maxFileBytes=1024/);
    });

    it('rejects a streamed result with declared size before reading the body', async () => {
      let cancelled = false;
      let bytesPulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(1024);
          bytesPulled += chunk.byteLength;
          controller.enqueue(chunk);
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const runtime = edgeRuntime({
        // 5 MB declared, 4 MiB cap (the scenario from the audit).
        maxFileBytes: 4 * 1024 * 1024,
        fileStore: async () => ({ size: 5 * 1024 * 1024, stream }),
      });
      await expect(runtime.readFile('/declared-too-big')).rejects.toThrow(/exceeds maxFileBytes=/);
      // The runtime never reads the body — only the declared size matters.
      // Even if the stream's start/pull was invoked by the runtime, the
      // bytes are not accumulated through the reader. Cancellation is
      // observable so downstream platforms can free resources.
      expect(cancelled).toBe(true);
      // No reader ever consumed bytes — at most one synchronous pull from
      // the stream's internal queue, but never accumulated.
      expect(bytesPulled).toBeLessThanOrEqual(1024);
    });

    it('aborts a stream with no declared size once accumulated bytes exceed the cap', async () => {
      // Cap at 1 KB, send 4 KB in 1 KB chunks. The reader should cancel after
      // the second chunk.
      const cap = 1024;
      let chunksDelivered = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksDelivered >= 4) {
            controller.close();
            return;
          }
          chunksDelivered++;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: cap,
        fileStore: async () => ({ stream }),
      });
      await expect(runtime.readFile('/streamed-too-big')).rejects.toThrow(
        /exceeds maxFileBytes=1024/,
      );
      expect(cancelled).toBe(true);
      // We rejected before pulling the whole body. Some streams may
      // pre-queue an extra chunk, so allow a little slack — the key
      // assertion is that we did NOT pull all 4.
      expect(chunksDelivered).toBeLessThan(4);
    });

    it('returns the decoded text for a streamed result within the cap', async () => {
      const text = 'hello-stream';
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ size: bytes.byteLength, stream }),
      });
      expect(await runtime.readFile('/ok-stream')).toBe(text);
    });

    it('honours maxFileBytes=0 as "no cap" for streamed results', async () => {
      const bytes = new Uint8Array(8 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => ({ size: bytes.byteLength, stream }),
      });
      const result = await runtime.readFile('/uncapped');
      expect(result).not.toBeNull();
      expect((result as string).length).toBe(8 * 1024);
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

    it('returns false when the stored hash payload is not valid base64', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.password.verify('password', '%%%:%%%')).resolves.toBe(false);
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

    it('rejects partially customized password handlers', () => {
      expect(() =>
        edgeRuntime({
          hashPassword: async plain => `custom:${plain}`,
        }),
      ).toThrow('hashPassword and verifyPassword must both be provided');

      expect(() =>
        edgeRuntime({
          verifyPassword: async () => true,
        }),
      ).toThrow('hashPassword and verifyPassword must both be provided');
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
