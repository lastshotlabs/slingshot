// packages/runtime-edge/tests/unit/file-reads.test.ts
//
// Tests for edgeRuntime().readFile() focusing on:
//   - withTimeout bounded fileStore lookup (returns null on timeout)
//   - maxFileBytes cap at all three levels:
//       1. FileStoreStream with declared size > maxFileBytes
//       2. FileStoreStream without declared size, streaming accumulation
//       3. Plain string return, buffered byte-length check after the fact
//   - FileStoreStream interface (optional size, ReadableStream body)
//   - Boundary conditions (exact cap, zero cap, timeout disabled)

import { describe, expect, it } from 'bun:test';
import { configureRuntimeEdgeLogger, edgeRuntime } from '../../src/index';
import type { FileStoreStream } from '../../src/index';

// ---------------------------------------------------------------------------
// Custom logger spy (compatible with slingshot-core Logger)
// ---------------------------------------------------------------------------

function createSpyLogger() {
  const events: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug(msg: string, fields?: Record<string, unknown>) {
      events.push({ level: 'debug', msg, fields });
    },
    info(msg: string, fields?: Record<string, unknown>) {
      events.push({ level: 'info', msg, fields });
    },
    warn(msg: string, fields?: Record<string, unknown>) {
      events.push({ level: 'warn', msg, fields });
    },
    error(msg: string, fields?: Record<string, unknown>) {
      events.push({ level: 'error', msg, fields });
    },
    child() {
      return logger;
    },
  };
  return { logger, events };
}

describe('readFile() — fileStore withTimeout and maxFileBytes cap', () => {
  // -----------------------------------------------------------------------
  // Level 1: FileStoreStream with declared size > maxFileBytes
  // -----------------------------------------------------------------------

  describe('cap level 1 — declared size on FileStoreStream', () => {
    it('rejects before reading when declared size exceeds maxFileBytes', async () => {
      let cancelled = false;
      let bytesPulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(10);
          bytesPulled += chunk.byteLength;
          controller.enqueue(chunk);
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ size: 500, stream }),
      });

      await expect(runtime.readFile('/big-declared')).rejects.toThrow(/exceeds maxFileBytes=100/);
      expect(cancelled).toBe(true);
      // The runtime rejects based on declared size, not accumulated bytes.
      // Some ReadableStream implementations may call pull before cancel;
      // the key assertion is that total pulled bytes is very small (< 50).
      expect(bytesPulled).toBeLessThanOrEqual(50);
    });

    it('accepts when declared size exactly equals maxFileBytes', async () => {
      const data = 'x'.repeat(100);
      const bytes = new TextEncoder().encode(data);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ size: bytes.byteLength, stream }),
      });

      const result = await runtime.readFile('/exact-cap');
      expect(result).toBe(data);
    });

    it('accepts when declared size is under maxFileBytes', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('small'));
          controller.close();
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ size: 5, stream }),
      });

      expect(await runtime.readFile('/small-declared')).toBe('small');
    });
  });

  // -----------------------------------------------------------------------
  // Level 2: Streaming accumulation (no declared size)
  // -----------------------------------------------------------------------

  describe('cap level 2 — streaming accumulation', () => {
    it('aborts when accumulated bytes exceed maxFileBytes (no declared size)', async () => {
      const cap = 1500; // 1.5 KB
      const chunkSize = 1024; // 1 KB chunks
      let chunksSent = 0;
      let cancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksSent >= 5) {
            controller.close();
            return;
          }
          chunksSent++;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          cancelled = true;
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: cap,
        fileStore: async () => ({ stream }),
      });

      await expect(runtime.readFile('/streamed-oversize')).rejects.toThrow(
        /exceeds maxFileBytes=1500/,
      );
      expect(cancelled).toBe(true);
      // We should have rejected before pulling all 5 chunks
      expect(chunksSent).toBeLessThan(5);
    });

    it('accepts streamed payload under maxFileBytes with no declared size', async () => {
      const text = 'under-the-cap';
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });

      expect(await runtime.readFile('/under-cap')).toBe(text);
    });

    it('handles multiple small chunks within the cap', async () => {
      const words = ['hello', '-', 'stream', '-', 'world'];
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (words.length === 0) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(words.shift()!));
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });

      expect(await runtime.readFile('/multi-chunk')).toBe('hello-stream-world');
    });
  });

  // -----------------------------------------------------------------------
  // Level 3: Plain string return, post-hoc byte-length check
  // -----------------------------------------------------------------------

  describe('cap level 3 — buffered string byte-length check', () => {
    it('rejects a string whose UTF-8 byte length exceeds maxFileBytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => 'x'.repeat(200),
      });

      await expect(runtime.readFile('/big-string')).rejects.toThrow(/exceeds maxFileBytes=100/);
    });

    it('accepts a string whose UTF-8 byte length equals maxFileBytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => 'x'.repeat(100),
      });

      expect(await runtime.readFile('/exact-string')).toBe('x'.repeat(100));
    });

    it('accepts a string under maxFileBytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => 'small content',
      });

      expect(await runtime.readFile('/small-string')).toBe('small content');
    });

    it('measures byte length correctly for multibyte characters', async () => {
      // '♥' is 3 bytes in UTF-8, '😀' is 4 bytes
      const multiByte = 'a'.repeat(50) + '♥'.repeat(50) + '😀'.repeat(50);
      // 50*1 + 50*3 + 50*4 = 400 bytes
      const runtime = edgeRuntime({
        maxFileBytes: 400,
        fileStore: async () => multiByte,
      });

      // Should be exactly at the cap (400 bytes)
      expect(await runtime.readFile('/unicode-string')).toBe(multiByte);
    });

    it('rejects a string with multibyte characters that exceeds maxFileBytes', async () => {
      // '😀' is 4 bytes each; 256 chars = 1024 bytes
      const multiByte = '😀'.repeat(256);
      const runtime = edgeRuntime({
        maxFileBytes: 512,
        fileStore: async () => multiByte,
      });

      await expect(runtime.readFile('/big-unicode')).rejects.toThrow(/exceeds maxFileBytes=512/);
    });
  });

  // -----------------------------------------------------------------------
  // FileStoreStream structural interface
  // -----------------------------------------------------------------------

  describe('FileStoreStream interface', () => {
    it('accepts a FileStoreStream with only stream (no size)', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('no-size'));
          controller.close();
        },
      });

      const fileStoreResult: FileStoreStream = { stream };
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => fileStoreResult,
      });

      expect(await runtime.readFile('/no-size')).toBe('no-size');
    });

    it('accepts a FileStoreStream with size: 0', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('zero-size'));
          controller.close();
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ size: 0, stream }),
      });

      // size 0 is not > maxFileBytes, so it passes the declared-size check
      expect(await runtime.readFile('/zero-size')).toBe('zero-size');
    });

    it('cancels the stream on declared-size rejection but still throws', async () => {
      let cancelCalled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelCalled = true;
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 10,
        fileStore: async () => ({ size: 100, stream }),
      });

      await expect(runtime.readFile('/cancelled')).rejects.toThrow();
      expect(cancelCalled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // withTimeout bounded fileStore lookup
  // -----------------------------------------------------------------------

  describe('fileStore timeout (withTimeout bounded lookup)', () => {
    it('returns null when fileStore exceeds the configured timeout', async () => {
      const { logger, events } = createSpyLogger();
      const previous = configureRuntimeEdgeLogger(logger);
      try {
        const runtime = edgeRuntime({
          fileStoreTimeoutMs: 30,
          fileStore: () => new Promise(() => {}), // never settles
        });

        const start = Date.now();
        const result = await runtime.readFile('/timeout');
        const elapsed = Date.now() - start;

        expect(result).toBeNull();
        expect(elapsed).toBeGreaterThanOrEqual(15);
        expect(elapsed).toBeLessThan(2000);

        const warnEvent = events.find(e => e.level === 'warn' && e.msg === 'file-store-timeout');
        expect(warnEvent).toBeDefined();
        expect(warnEvent!.fields?.path).toBe('/timeout');
        expect(warnEvent!.fields?.timeoutMs).toBe(30);
      } finally {
        configureRuntimeEdgeLogger(previous);
      }
    });

    it('treats a timeout as a miss (return null) rather than throwing', async () => {
      const { logger } = createSpyLogger();
      const previous = configureRuntimeEdgeLogger(logger);
      try {
        const runtime = edgeRuntime({
          fileStoreTimeoutMs: 20,
          fileStore: () => new Promise(() => {}),
        });

        // The contract says TimeoutError is caught and returned as null,
        // so readFile should not throw for a timeout
        const result = await runtime.readFile('/timeout-miss');
        expect(result).toBeNull();
      } finally {
        configureRuntimeEdgeLogger(previous);
      }
    });

    it('honours fileStoreTimeoutMs=0 (no timeout)', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 0,
        fileStore: async path => `data for ${path}`,
      });

      expect(await runtime.readFile('/no-timeout')).toBe('data for /no-timeout');
    });

    it('does not time out when fileStore resolves quickly', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 5000,
        fileStore: async () => 'quick',
      });

      expect(await runtime.readFile('/quick')).toBe('quick');
    });

    it('default fileStoreTimeoutMs is 5000 (no timeout for fast stores)', async () => {
      const runtime = edgeRuntime({
        fileStore: () => Promise.resolve('fast'),
      });

      expect(await runtime.readFile('/fast')).toBe('fast');
    });
  });

  // -----------------------------------------------------------------------
  // General edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns null when fileStore returns null', async () => {
      const runtime = edgeRuntime({
        fileStore: async () => null,
      });

      expect(await runtime.readFile('/null')).toBeNull();
    });

    it('returns null when no fileStore is configured at all', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.readFile('/unconfigured')).toBeNull();
    });

    it('propagates non-timeout errors from fileStore', async () => {
      const runtime = edgeRuntime({
        fileStore: async () => {
          throw new Error('store-error');
        },
      });

      await expect(runtime.readFile('/error')).rejects.toThrow('store-error');
    });

    it('honours maxFileBytes=0 as unlimited for string results', async () => {
      const large = 'x'.repeat(10 * 1024 * 1024); // 10 MB
      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => large,
      });

      const result = await runtime.readFile('/unlimited-string');
      expect(result).toBe(large);
    });

    it('honours maxFileBytes=0 as unlimited for streamed results', async () => {
      const large = new Uint8Array(5 * 1024 * 1024); // 5 MB
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(large);
          controller.close();
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => ({ stream }),
      });

      const result = await runtime.readFile('/unlimited-stream');
      expect(result).not.toBeNull();
      expect(new TextEncoder().encode(result!).byteLength).toBe(5 * 1024 * 1024);
    });
  });
});
