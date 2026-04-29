// packages/runtime-edge/tests/unit/capabilities.test.ts
//
// Tests for the capabilities contract of edgeRuntime(). Verifies that the
// returned SlingshotRuntime is properly frozen, that unsupported capabilities
// are stubbed with frozen objects, and that the runtime shape matches the
// expected interface.
//
// Coverage:
//   - edgeRuntime() returns an Object.freeze'd runtime
//   - supportsAsyncLocalStorage is false and is a const (readonly)
//   - Frozen stubs for all unsupported capabilities (sqlite, server, fs, glob)
//   - Frozen runtime cannot be mutated (throws in strict mode)
//   - All sub-objects (password, fs, glob, sqlite, server) are individually frozen
//   - Required properties exist and have correct types
//   - password sub-object methods are functions
//   - readFile is a function
import { describe, expect, it } from 'bun:test';
import type { SlingshotRuntime } from '@lastshotlabs/slingshot-core';
import { edgeRuntime } from '../../src/index';

describe('edgeRuntime() capabilities', () => {
  // -------------------------------------------------------------------------
  // Runtime-level freeze
  // -------------------------------------------------------------------------

  describe('frozen runtime', () => {
    it('returns an Object.freeze runtime (single-quote safe)', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime)).toBe(true);
    });

    it('cannot mutate runtime properties (strict mode throws)', () => {
      const runtime = edgeRuntime();
      // In bun:test (strict mode), assigning to a frozen object's property throws.
      expect(() => {
        (runtime as unknown as Record<string, unknown>).supportsAsyncLocalStorage = true;
      }).toThrow();
    });

    it('cannot delete runtime properties (strict mode throws)', () => {
      const runtime = edgeRuntime();
      expect(() => {
        delete (runtime as unknown as Record<string, unknown>).supportsAsyncLocalStorage;
      }).toThrow();
    });

    it('cannot add new properties to the runtime', () => {
      const runtime = edgeRuntime();
      expect(() => {
        (runtime as unknown as Record<string, unknown>).newProp = 'value';
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // supportsAsyncLocalStorage
  // -------------------------------------------------------------------------

  describe('supportsAsyncLocalStorage', () => {
    it('is false', () => {
      const runtime = edgeRuntime();
      expect(runtime.supportsAsyncLocalStorage).toBe(false);
    });

    it('is typed as false (not just boolean)', () => {
      const runtime = edgeRuntime();
      // TypeScript narrows to false via 'as const' — at runtime verify the
      // value is strictly false and not falsy (null, undefined, 0).
      expect(runtime.supportsAsyncLocalStorage).toBe(false);
      expect(typeof runtime.supportsAsyncLocalStorage).toBe('boolean');
    });
  });

  // -------------------------------------------------------------------------
  // Frozen stubs for unsupported capabilities
  // -------------------------------------------------------------------------

  describe('frozen stubs for unsupported capabilities', () => {
    it('sqlite object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.sqlite)).toBe(true);
    });

    it('server object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.server)).toBe(true);
    });

    it('fs object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.fs)).toBe(true);
    });

    it('glob object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.glob)).toBe(true);
    });

    it('password object is frozen', () => {
      const runtime = edgeRuntime();
      expect(Object.isFrozen(runtime.password)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Runtime shape (SlingshotRuntime interface conformance)
  // -------------------------------------------------------------------------

  describe('runtime shape satisfies SlingshotRuntime', () => {
    it('has all required top-level properties', () => {
      const runtime = edgeRuntime();
      const props: Array<keyof SlingshotRuntime> = [
        'password',
        'sqlite',
        'server',
        'fs',
        'glob',
        'readFile',
        'supportsAsyncLocalStorage',
      ];
      for (const prop of props) {
        expect(runtime).toHaveProperty(prop);
      }
    });

    it('password sub-object has hash and verify functions', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.password.hash).toBe('function');
      expect(typeof runtime.password.verify).toBe('function');
      expect(runtime.password.hash.length).toBe(1); // (plain: string)
      expect(runtime.password.verify.length).toBe(2); // (plain: string, hash: string)
    });

    it('readFile is a function with arity 1', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.readFile).toBe('function');
      expect(runtime.readFile.length).toBe(1); // (path: string)
    });

    it('sqlite.open is a function', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.sqlite.open).toBe('function');
    });

    it('server.listen is a function', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.server.listen).toBe('function');
    });

    it('fs has write, readFile, and exists functions', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.fs.write).toBe('function');
      expect(typeof runtime.fs.readFile).toBe('function');
      expect(typeof runtime.fs.exists).toBe('function');
    });

    it('glob has scan function', () => {
      const runtime = edgeRuntime();
      expect(typeof runtime.glob.scan).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Factory with options (re-freeze)
  // -------------------------------------------------------------------------

  describe('factory with options', () => {
    it('returns frozen runtime when fileStore is provided', () => {
      const runtime = edgeRuntime({
        fileStore: async () => null,
      });
      expect(Object.isFrozen(runtime)).toBe(true);
    });

    it('returns frozen runtime when custom password hashing is provided', () => {
      const runtime = edgeRuntime({
        hashPassword: async pw => `hash:${pw}`,
        verifyPassword: async (pw, hash) => hash === `hash:${pw}`,
      });
      expect(Object.isFrozen(runtime)).toBe(true);
    });

    it('returns frozen runtime with maxFileBytes set', () => {
      const runtime = edgeRuntime({ maxFileBytes: 512 });
      expect(Object.isFrozen(runtime)).toBe(true);
    });

    it('returns frozen runtime with fileStoreTimeoutMs set', () => {
      const runtime = edgeRuntime({ fileStoreTimeoutMs: 100 });
      expect(Object.isFrozen(runtime)).toBe(true);
    });
  });
});
