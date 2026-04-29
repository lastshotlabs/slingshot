// packages/runtime-edge/tests/unit/prod-hardening-2.test.ts
//
// Additional prod-hardening tests for the edge runtime, complementing the
// existing prod-hardening.test.ts with focus on:
//
//   - Concurrent file reads (parallel readFile calls)
//   - Large file rejection at all three cap levels
//   - Timeout on slow fileStore with concurrent calls
//   - undefined/null handling in fileStore results
//   - Stress: many concurrent reads with a mix of found/not-found paths
//   - FileStore that switches between string and FileStoreStream responses
import { describe, expect, it } from 'bun:test';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { configureRuntimeEdgeLogger, edgeRuntime } from '../../src/index';

// ---------------------------------------------------------------------------
// Helper: capture logger warnings
// ---------------------------------------------------------------------------

function captureLogger(): {
  logger: Logger;
  warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return this as unknown as Logger;
    },
  };
  return { logger, warns };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prod hardening 2', () => {
  // -----------------------------------------------------------------------
  // Concurrent file reads
  // -----------------------------------------------------------------------

  describe('concurrent file reads', () => {
    it('handles multiple concurrent readFile calls', async () => {
      const store = new Map<string, string>();
      store.set('/a', 'content-a');
      store.set('/b', 'content-b');
      store.set('/c', 'content-c');

      const runtime = edgeRuntime({
        fileStore: async path => store.get(path) ?? null,
      });

      const [a, b, c] = await Promise.all([
        runtime.readFile('/a'),
        runtime.readFile('/b'),
        runtime.readFile('/c'),
      ]);

      expect(a).toBe('content-a');
      expect(b).toBe('content-b');
      expect(c).toBe('content-c');
    });

    it('handles concurrent reads where some paths exist and some do not', async () => {
      const runtime = edgeRuntime({
        fileStore: async path => (path === '/exists' ? 'found' : null),
      });

      const results = await Promise.all([
        runtime.readFile('/exists'),
        runtime.readFile('/missing'),
        runtime.readFile('/also-missing'),
        runtime.readFile('/exists'),
      ]);

      expect(results).toEqual(['found', null, null, 'found']);
    });

    it('handles many concurrent reads (50 paths at once)', async () => {
      const runtime = edgeRuntime({
        fileStore: async path => `data:${path}`,
      });

      const paths = Array.from({ length: 50 }, (_, i) => `/path-${i}`);
      const results = await Promise.all(paths.map(p => runtime.readFile(p)));

      for (let i = 0; i < 50; i++) {
        expect(results[i]).toBe(`data:/path-${i}`);
      }
    });

    it('handles concurrent streamed reads', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async () => ({
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('streamed'));
              controller.close();
            },
          }),
        }),
      });

      const results = await Promise.all([
        runtime.readFile('/s1'),
        runtime.readFile('/s2'),
        runtime.readFile('/s3'),
      ]);

      for (const r of results) {
        expect(r).toBe('streamed');
      }
    });

    it('concurrent reads do not interfere with each other when one throws', async () => {
      let callCount = 0;
      const runtime = edgeRuntime({
        fileStore: async path => {
          callCount++;
          if (path === '/throw') throw new Error('epic-fail');
          return 'ok';
        },
      });

      const results = await Promise.allSettled([
        runtime.readFile('/throw'),
        runtime.readFile('/fine'),
        runtime.readFile('/fine2'),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      if (results[1].status === 'fulfilled') expect(results[1].value).toBe('ok');
      expect(results[2].status).toBe('fulfilled');
      if (results[2].status === 'fulfilled') expect(results[2].value).toBe('ok');
    });
  });

  // -----------------------------------------------------------------------
  // Large file rejection — additional edge cases
  // -----------------------------------------------------------------------

  describe('large file rejection edge cases', () => {
    it('rejects when a stream produces a chunk that pushes cumulative bytes over the cap', async () => {
      // Cap at 100 bytes. Send a 60-byte chunk (under cap), then a 60-byte
      // chunk (pushes total to 120 > 100).
      let chunksDelivered = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksDelivered++;
          if (chunksDelivered > 3) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(60));
        },
      });

      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => ({ stream }),
      });

      await expect(runtime.readFile('/over-on-second-chunk')).rejects.toThrow(
        /exceeds maxFileBytes=100/,
      );
      // We should have rejected before pulling all streamed data.
      // Some ReadableStream implementations may pre-fetch an extra chunk
      // internally; the key assertion is that chunksDelivered is less
      // than the total available (4+).
      expect(chunksDelivered).toBeLessThan(4);
    });

    it('rejects a string result whose UTF-8 byte length is just over maxFileBytes', async () => {
      // maxFileBytes=100, string is 101 bytes
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => 'x'.repeat(101),
      });

      await expect(runtime.readFile('/just-over')).rejects.toThrow(/exceeds maxFileBytes=100/);
    });

    it('accepts a string result whose UTF-8 byte length is just under maxFileBytes', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 100,
        fileStore: async () => 'x'.repeat(99),
      });

      expect(await runtime.readFile('/just-under')).toBe('x'.repeat(99));
    });

    it('rejects a stream whose declared size pushes it just over the cap', async () => {
      const stream = new ReadableStream<Uint8Array>({ pull() {} });
      const runtime = edgeRuntime({
        maxFileBytes: 1000,
        fileStore: async () => ({ size: 1001, stream }),
      });

      await expect(runtime.readFile('/just-over-declared')).rejects.toThrow(
        /exceeds maxFileBytes=1000/,
      );
    });

    it('handles empty stream with maxFileBytes=0 correctly', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 0,
        fileStore: async () => ({ stream }),
      });

      expect(await runtime.readFile('/empty-stream-unlimited')).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // Timeout on slow fileStore
  // -----------------------------------------------------------------------

  describe('timeout on slow fileStore', () => {
    it('multiple concurrent timeouts all return null', async () => {
      const { logger, warns } = captureLogger();
      const prev = configureRuntimeEdgeLogger(logger);
      try {
        const runtime = edgeRuntime({
          fileStoreTimeoutMs: 30,
          fileStore: () => new Promise(() => {}),
        });

        const results = await Promise.all([
          runtime.readFile('/a'),
          runtime.readFile('/b'),
          runtime.readFile('/c'),
        ]);

        expect(results).toEqual([null, null, null]);
        expect(warns.length).toBe(3);
        warns.forEach((w, i) => {
          expect(w.msg).toBe('file-store-timeout');
        });
      } finally {
        configureRuntimeEdgeLogger(prev);
      }
    });

    it('fast and slow fileStore results interleaved', async () => {
      const { logger } = captureLogger();
      const prev = configureRuntimeEdgeLogger(logger);
      try {
        let callIndex = 0;
        const runtime = edgeRuntime({
          fileStoreTimeoutMs: 50,
          fileStore: async () => {
            const idx = callIndex++;
            if (idx === 1) {
              // Slow call — never resolves
              return new Promise<string>(() => {}) as never;
            }
            return `fast-${idx}`;
          },
        });

        const results = await Promise.allSettled([
          runtime.readFile('/fast-0'),
          runtime.readFile('/slow'),
          runtime.readFile('/fast-2'),
        ]);

        // Fast calls should resolve to their content
        expect(results[0].status).toBe('fulfilled');
        if (results[0].status === 'fulfilled') expect(results[0].value).toBe('fast-0');
        // Slow call should time out and return null (not throw)
        expect(results[1].status).toBe('fulfilled');
        if (results[1].status === 'fulfilled') expect(results[1].value).toBeNull();
        // Second fast call
        expect(results[2].status).toBe('fulfilled');
        if (results[2].status === 'fulfilled') expect(results[2].value).toBe('fast-2');
      } finally {
        configureRuntimeEdgeLogger(prev);
      }
    });

    it('fileStore that resolves just under the timeout passes through', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 200,
        fileStore: () =>
          new Promise(resolve => {
            setTimeout(() => resolve('barely-in-time'), 100);
          }),
      });

      const result = await runtime.readFile('/barely');
      expect(result).toBe('barely-in-time');
    });
  });

  // -----------------------------------------------------------------------
  // undefined/null handling
  // -----------------------------------------------------------------------

  describe('undefined/null handling', () => {
    it('handles fileStore returning undefined gracefully', async () => {
      // FileStoreResult is `string | FileStoreStream | null`, but at runtime
      // a misbehaving store could return undefined.
      const runtime = edgeRuntime({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileStore: async () => undefined as any,
      });

      // undefined is not null (so the null check passes), not a string,
      // and not a valid object to destructure — this would throw.
      // The important test is that the error is a runtime error, not a
      // silent undefined-is-treated-as-null behaviour.
      await expect(runtime.readFile('/undefined')).rejects.toThrow();
    });

    it('handles fileStore returning a non-string, non-object result', async () => {
      const runtime = edgeRuntime({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileStore: async () => 42 as any,
      });

      // 42 === null is false; typeof 42 is 'number', not 'string',
      // and 42 is not an object — destructuring throws.
      await expect(runtime.readFile('/number')).rejects.toThrow();
    });

    it('passes null path through to fileStore without crashing', async () => {
      const runtime = edgeRuntime({
        fileStore: async (path: string) => `path:${path}`,
      });

      // readFile is typed as (path: string), but at runtime could be called
      // with null — the value is passed through to fileStore verbatim.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await runtime.readFile(null as any);
      expect(result).toBe('path:null');
    });

    it('handles fileStoreStream with null stream', async () => {
      const runtime = edgeRuntime({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileStore: async () => ({ size: 100, stream: null }) as any,
      });

      // stream is not a valid ReadableStream — getReader() on null throws
      await expect(runtime.readFile('/null-stream')).rejects.toThrow();
    });

    it('fileStore returning an object without stream property', async () => {
      const runtime = edgeRuntime({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileStore: async () => ({ size: 100 }) as any,
      });

      // stream is undefined; stream.getReader() throws
      await expect(runtime.readFile('/no-stream-prop')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Mixed string/stream responses from the same fileStore
  // -----------------------------------------------------------------------

  describe('mixed fileStore responses', () => {
    it('handles fileStore that returns strings and streams for different paths', async () => {
      const runtime = edgeRuntime({
        maxFileBytes: 1024,
        fileStore: async (path: string) => {
          if (path === '/small') return 'small-content';
          if (path === '/streamed') {
            return {
              stream: new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new TextEncoder().encode('streamed-content'));
                  controller.close();
                },
              }),
            };
          }
          return null;
        },
      });

      const [small, streamed, missing] = await Promise.all([
        runtime.readFile('/small'),
        runtime.readFile('/streamed'),
        runtime.readFile('/missing'),
      ]);

      expect(small).toBe('small-content');
      expect(streamed).toBe('streamed-content');
      expect(missing).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // FileStore that throws on specific calls
  // -----------------------------------------------------------------------

  describe('fileStore error isolation', () => {
    it('a fileStore error on one path does not affect other paths', async () => {
      let callCount = 0;
      const runtime = edgeRuntime({
        fileStore: async (path: string) => {
          callCount++;
          if (path === '/bad') throw new Error('bad-path');
          return `ok-for-${path}`;
        },
      });

      const results = await Promise.allSettled([
        runtime.readFile('/good'),
        runtime.readFile('/bad'),
        runtime.readFile('/good2'),
      ]);

      expect(results[0].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled') expect(results[0].value).toBe('ok-for-/good');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
      if (results[2].status === 'fulfilled') expect(results[2].value).toBe('ok-for-/good2');
    });
  });
});
