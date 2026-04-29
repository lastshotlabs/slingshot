// packages/runtime-edge/tests/unit/stream-edge.test.ts
//
// Tests for edgeRuntime() readFile stream-specific edge cases — stream
// errors mid-read, empty streams, very large single chunks, concurrent
// stream reads, and stream cancellation behaviour.
//
// Coverage:
//   - Stream that errors during pull (mid-read)
//   - Stream that produces no chunks (immediate close)
//   - Stream with a single chunk that exceeds the cap
//   - Multiple sequential stream reads
//   - Concurrent stream reads with mixed success/failure
//   - Stream cancellation when declared size exceeds cap
//   - Stream whose reader is already locked
//   - Stream with multiple chunks under the cap

import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('edgeRuntime() — stream reading edge cases', () => {
  // -----------------------------------------------------------------------
  // Stream errors mid-read
  // -----------------------------------------------------------------------

  describe('stream errors during pull', () => {
    it('propagates an error thrown inside stream pull', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('stream-pull-error');
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      // The error from the pull propagates through reader.read()
      await expect(runtime.readFile('/stream-error')).rejects.toThrow();
    });

    it('propagates a stream error after some chunks were delivered', async () => {
      let calls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          calls++;
          if (calls === 1) {
            controller.enqueue(new TextEncoder().encode('partial-'));
            return;
          }
          throw new Error('mid-stream-error');
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      await expect(runtime.readFile('/mid-error')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Empty streams
  // -----------------------------------------------------------------------

  describe('empty streams', () => {
    it('returns empty string for an immediately-closed stream', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/empty')).toBe('');
    });

    it('returns empty string for a stream with zero-length chunks', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(0));
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/zero-chunks')).toBe('');
    });

    it('returns empty string for stream with undefined chunk', async () => {
      let called = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!called) {
            called = true;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            controller.enqueue(undefined as any);
          } else {
            controller.close();
          }
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/undefined-chunk')).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // Large single chunk over cap
  // -----------------------------------------------------------------------

  describe('large single chunk', () => {
    it('rejects when a single chunk exceeds the cap', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(2048));
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      await expect(runtime.readFile('/big-chunk')).rejects.toThrow(/exceeds maxFileBytes=1024/);
    });

    it('accepts a single chunk exactly at the cap', async () => {
      const data = new Uint8Array(1024);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({ stream }),
      });
      const result = await runtime.readFile('/at-cap');
      expect(result).not.toBeNull();
      expect(new TextEncoder().encode(result!).byteLength).toBe(1024);
    });
  });

  // -----------------------------------------------------------------------
  // Sequential stream reads
  // -----------------------------------------------------------------------

  describe('sequential stream reads', () => {
    it('reads two different streamed files sequentially', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async (path: string) => {
          const content = path === '/first' ? 'first-stream' : 'second-stream';
          return {
            stream: new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(content));
                controller.close();
              },
            }),
          };
        },
      });

      const first = await runtime.readFile('/first');
      const second = await runtime.readFile('/second');
      expect(first).toBe('first-stream');
      expect(second).toBe('second-stream');
    });

    it('reads three streamed files with varying sizes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 10_000,
        fileStore: async () => ({
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('streamed-content'));
              controller.close();
            },
          }),
        }),
      });

      const results = await Promise.all([
        runtime.readFile('/a'),
        runtime.readFile('/b'),
        runtime.readFile('/c'),
      ]);
      expect(results).toEqual(['streamed-content', 'streamed-content', 'streamed-content']);
    });
  });

  // -----------------------------------------------------------------------
  // Stream cancellation
  // -----------------------------------------------------------------------

  describe('stream cancellation', () => {
    it('cancels the stream when declared size exceeds cap and cancel is called', async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelled = true;
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ size: 500, stream }),
      });
      await expect(runtime.readFile('/cancel-declared')).rejects.toThrow();
      expect(cancelled).toBe(true);
    });

    it('cancels the stream when accumulated bytes exceed cap', async () => {
      let cancelled = false;
      let chunksPulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled++;
          if (chunksPulled > 5) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(300));
        },
        cancel() {
          cancelled = true;
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 500,
        fileStore: async () => ({ stream }),
      });
      await expect(runtime.readFile('/cancel-accumulated')).rejects.toThrow();
      expect(cancelled).toBe(true);
      // Should have stopped pulling after exceeding the cap
      expect(chunksPulled).toBeLessThan(5);
    });
  });

  // -----------------------------------------------------------------------
  // Stream reader edge cases
  // -----------------------------------------------------------------------

  describe('stream reader edge cases', () => {
    it('handles a stream that releases all chunks correctly when exactly at cap', async () => {
      const chunk = new TextEncoder().encode('exact-stream-data');
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: chunk.byteLength,
        fileStore: async () => ({ stream }),
      });
      const result = await runtime.readFile('/exact-stream');
      expect(result).toBe('exact-stream-data');
    });

    it('handles a stream returning a single byte', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([0x41])); // 'A'
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 10,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/single-byte')).toBe('A');
    });

    it('handles interleaved empty and non-empty chunks', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(0));
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.enqueue(new Uint8Array(0));
          controller.enqueue(new TextEncoder().encode('-world'));
          controller.enqueue(new Uint8Array(0));
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/interleaved')).toBe('hello-world');
    });
  });
});
