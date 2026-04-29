// packages/runtime-edge/tests/unit/stubs.test.ts
//
// Tests that the edge runtime stubs for unsupported capabilities produce
// clear [runtime-edge] error messages. These stubs exist so that internal
// framework code that calls fs.write(), glob.scan(), sqlite.open(), or
// server.listen() on edge runtimes gets an informative error rather than
// a generic "undefined is not a function" or a silent no-op.
//
// Coverage:
//   - fs.write() rejects with [runtime-edge] for various data types
//   - fs.readFile() and fs.exists() return null/false (no filesystem)
//   - glob.scan() rejects with [runtime-edge] for various patterns and options
//   - sqlite.open() throws with [runtime-edge]
//   - server.listen() throws with [runtime-edge]
//   - All stub objects are Object.freeze'd
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('edge runtime stubs', () => {
  describe('fs (RuntimeFs stub)', () => {
    it('fs.write rejects with [runtime-edge] prefix', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.fs.write('/path', 'data')).rejects.toThrow('[runtime-edge]');
    });

    it('fs.write rejects with advisory text about external storage', async () => {
      const runtime = edgeRuntime();
      try {
        await runtime.fs.write('/path', 'data');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('Filesystem writes are not supported');
        expect(msg).toContain('KV, R2');
      }
    });

    it('fs.write rejects for Uint8Array data type', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.fs.write('/bin', new Uint8Array([0, 1, 2]))).rejects.toThrow(
        '[runtime-edge]',
      );
    });

    it('fs.write rejects for empty data', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.fs.write('/empty', '')).rejects.toThrow('[runtime-edge]');
    });

    it('fs.readFile returns null for any path', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.fs.readFile('/any/path')).toBeNull();
      expect(await runtime.fs.readFile('/')).toBeNull();
      expect(await runtime.fs.readFile('')).toBeNull();
    });

    it('fs.exists returns false for any path', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.fs.exists('/any/path')).toBe(false);
      expect(await runtime.fs.exists('/')).toBe(false);
      expect(await runtime.fs.exists('')).toBe(false);
    });
  });

  describe('glob (RuntimeGlob stub)', () => {
    it('glob.scan rejects with [runtime-edge] prefix', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.glob.scan('**/*.ts')).rejects.toThrow('[runtime-edge]');
    });

    it('glob.scan rejects with advisory text about build-time discovery', async () => {
      const runtime = edgeRuntime();
      try {
        await runtime.glob.scan('**/*.ts');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('Glob scanning is not supported');
        expect(msg).toContain('build time');
      }
    });

    it('glob.scan rejects for various glob patterns', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.glob.scan('*.route.ts')).rejects.toThrow('[runtime-edge]');
      await expect(runtime.glob.scan('**/*.{ts,js}')).rejects.toThrow('[runtime-edge]');
      await expect(runtime.glob.scan('')).rejects.toThrow('[runtime-edge]');
    });

    it('glob.scan rejects even with options provided', async () => {
      const runtime = edgeRuntime();
      await expect(runtime.glob.scan('**/*.ts', { cwd: '/some/dir' })).rejects.toThrow(
        '[runtime-edge]',
      );
    });
  });

  describe('sqlite stub', () => {
    it('sqlite.open throws with [runtime-edge] prefix', () => {
      const runtime = edgeRuntime();
      expect(() => runtime.sqlite.open('/some/db.sqlite')).toThrow('[runtime-edge]');
    });

    it('sqlite.open throws with advisory text about cloud databases', () => {
      const runtime = edgeRuntime();
      try {
        runtime.sqlite.open('/some/db.sqlite');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('SQLite is not supported');
        expect(msg).toContain('Cloudflare D1');
      }
    });

    it('sqlite.open throws for any argument', () => {
      const runtime = edgeRuntime();
      expect(() => runtime.sqlite.open(':memory:')).toThrow('[runtime-edge]');
      expect(() => runtime.sqlite.open('')).toThrow('[runtime-edge]');
    });
  });

  describe('server stub', () => {
    it('server.listen throws with [runtime-edge] prefix', () => {
      const runtime = edgeRuntime();
      expect(() => runtime.server.listen({} as never)).toThrow('[runtime-edge]');
    });

    it('server.listen throws with advisory text about fetch handlers', () => {
      const runtime = edgeRuntime();
      try {
        runtime.server.listen({} as never);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('listen() is not supported');
        expect(msg).toContain('fetch');
      }
    });

    it('server.listen throws even with valid-looking options', () => {
      const runtime = edgeRuntime();
      const opts = {
        port: 3000,
        hostname: '0.0.0.0',
        fetch: () => new Response('ok'),
      };
      expect(() => runtime.server.listen(opts as never)).toThrow('[runtime-edge]');
    });
  });

  describe('stub objects are frozen', () => {
    it('fs object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.fs)).toBe(true);
    });

    it('glob object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.glob)).toBe(true);
    });

    it('sqlite object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.sqlite)).toBe(true);
    });

    it('server object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.server)).toBe(true);
    });

    it('password object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.password)).toBe(true);
    });

    it('mutating a stub property is silently ignored (frozen)', () => {
      const runtime = edgeRuntime();
      // In non-strict mode, frozen object mutations are silently ignored
      // (in strict mode or bun test they throw). Either way, the original
      // stub stays intact.
      expect(() => {
        (runtime.fs as unknown as Record<string, unknown>).write = 'mutated' as never;
      }).toThrow(); // bun test runs in strict mode
    });
  });
});
