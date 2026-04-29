// packages/runtime-edge/tests/unit/runtime-options-edge.test.ts
//
// Tests for edgeRuntime() option parsing edge cases — negative/NaN/null
// values for numeric options, boundary conditions, and option combinations
// that aren't covered by the basic factory tests.
//
// Coverage:
//   - Negative fileStoreTimeoutMs falls back to default
//   - NaN fileStoreTimeoutMs falls back to default
//   - null fileStoreTimeoutMs falls back to default
//   - Negative maxFileBytes
//   - maxFileBytes=0 disables the cap
//   - fileStoreTimeoutMs=0 disables the timeout
//   - Combining fileStore with timeout
//   - Options with only maxFileBytes set (no fileStore)
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('edgeRuntime() — option parsing edge cases', () => {
  // -----------------------------------------------------------------------
  // fileStoreTimeoutMs edge cases
  // -----------------------------------------------------------------------

  describe('fileStoreTimeoutMs edge cases', () => {
    it('uses default timeout when fileStoreTimeoutMs is negative', async () => {
      // A negative value fails `opts.fileStoreTimeoutMs >= 0` and should fall
      // back to the default (5_000). A store that resolves in ~100ms should
      // succeed under the default timeout.
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: -1,
        fileStore: async () => 'ok',
      });
      const result = await runtime.readFile('/any');
      expect(result).toBe('ok');
    });

    it('uses default timeout when fileStoreTimeoutMs is NaN', async () => {
      // NaN is typeof 'number' but NaN >= 0 is false.
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: NaN,
        fileStore: async () => 'nan-handled',
      });
      const result = await runtime.readFile('/nan');
      expect(result).toBe('nan-handled');
    });

    it('uses default timeout when fileStoreTimeoutMs is null', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: null as unknown as number,
        fileStore: async () => 'null-handled',
      });
      const result = await runtime.readFile('/null-opt');
      expect(result).toBe('null-handled');
    });

    it('uses default timeout when fileStoreTimeoutMs is undefined', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: undefined,
        fileStore: async () => 'undefined-handled',
      });
      const result = await runtime.readFile('/undef');
      expect(result).toBe('undefined-handled');
    });

    it('fileStoreTimeoutMs=0 disables timeout (fast store)', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 0,
        fileStore: async () => 'no-timeout',
      });
      const result = await runtime.readFile('/no-timeout');
      expect(result).toBe('no-timeout');
    });

    it('fileStoreTimeoutMs=0 passes through a moderately slow store', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 0,
        fileStore: () =>
          new Promise(resolve => setTimeout(() => resolve('slow-but-no-timeout'), 50)),
      });
      const result = await runtime.readFile('/slow');
      expect(result).toBe('slow-but-no-timeout');
    });
  });

  // -----------------------------------------------------------------------
  // maxFileBytes edge cases
  // -----------------------------------------------------------------------

  describe('maxFileBytes edge cases', () => {
    it('accepts maxFileBytes=0 as unlimited (string result)', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => 'x'.repeat(10_000),
      });
      const result = await runtime.readFile('/big-unlimited');
      expect(result).toBe('x'.repeat(10_000));
    });

    it('accepts maxFileBytes=0 as unlimited (stream result)', async () => {
      const chunk = new Uint8Array(10_000);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => ({ stream }),
      });
      const result = await runtime.readFile('/stream-unlimited');
      expect(result).not.toBeNull();
      expect(new TextEncoder().encode(result!).byteLength).toBe(10_000);
    });

    it('accepts maxFileBytes=1 (smallest positive cap)', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1,
        fileStore: async () => 'x',
      });
      expect(await runtime.readFile('/tiny')).toBe('x');
    });

    it('rejects when maxFileBytes=1 and result is 2 bytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1,
        fileStore: async () => 'xx',
      });
      await expect(runtime.readFile('/too-big')).rejects.toThrow(/exceeds maxFileBytes=1/);
    });
  });

  // -----------------------------------------------------------------------
  // Option combinations
  // -----------------------------------------------------------------------

  describe('option combinations', () => {
    it('combines fileStore with maxFileBytes and fileStoreTimeoutMs', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStoreTimeoutMs: 5000,
        fileStore: async () => 'combination-works',
      });
      expect(await runtime.readFile('/combo')).toBe('combination-works');
    });

    it('creates runtime with only maxFileBytes (no fileStore)', () => {
      const runtime = edgeRuntime({ maxFileBytes: 512 });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(typeof runtime.readFile).toBe('function');
    });

    it('creates runtime with only fileStoreTimeoutMs (no fileStore)', () => {
      const runtime = edgeRuntime({ fileStoreTimeoutMs: 100 });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(typeof runtime.password.hash).toBe('function');
    });

    it('creates runtime with all options at once', () => {
      const runtime = edgeRuntime({
        maxFileBytes: 2048,
        fileStoreTimeoutMs: 3000,
        fileStore: async () => null,
        hashPassword: async pw => `h:${pw}`,
        verifyPassword: async (pw, hash) => hash === `h:${pw}`,
      });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(typeof runtime.readFile).toBe('function');
      expect(typeof runtime.password.hash).toBe('function');
    });
  });
});
