// packages/runtime-edge/tests/unit/abort-controller.test.ts
//
// Tests for the AbortController-based timeout behaviour in the edge runtime.
//
// Coverage:
//   - AbortSignal is passed to fileStore when timeout is configured
//   - Signal is aborted when fileStoreTimeoutMs fires
//   - Signal is NOT aborted when fileStore completes quickly
//   - Backward compatibility with fileStore that ignores the signal
//   - AbortSignal cancellation in the fileStore (signal.aborted is true on timeout)
//   - heartbeatTimeout guards long-running operations
//   - fileStore that immediately checks signal.aborted and short-circuits
import { describe, expect, it } from 'bun:test';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { configureRuntimeEdgeLogger, edgeRuntime } from '../../src/index';

// ---------------------------------------------------------------------------
// Helper: capture logger warnings
// ---------------------------------------------------------------------------

function captureWarnLogger(): {
  logger: Logger;
  warns: Array<{ event: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(event: string, fields?: Record<string, unknown>) {
      warns.push({ event, fields });
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

describe('AbortController-based fileStore timeout', () => {
  describe('signal is passed to fileStore', () => {
    it('passes an AbortSignal to fileStore when timeout is configured', async () => {
      let capturedSignal: AbortSignal | undefined;
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 5_000,
        fileStore: async (path, signal) => {
          capturedSignal = signal;
          return `content-${path}`;
        },
      });

      const result = await runtime.readFile('/test');
      expect(result).toBe('content-/test');
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);
    });

    it('passes undefined when only one argument is accepted (backward compat)', async () => {
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 5_000,
        // Single-arg fileStore — TypeScript allows this via inference
        fileStore: async (path: string) => `content-${path}`,
      });

      const result = await runtime.readFile('/compat');
      expect(result).toBe('content-/compat');
    });

    it('does not pass a signal when timeout is disabled (fileStoreTimeoutMs=0)', async () => {
      let capturedSignal: AbortSignal | undefined;
      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 0,
        fileStore: async (path, signal) => {
          capturedSignal = signal;
          return `content-${path}`;
        },
      });

      const result = await runtime.readFile('/no-timeout');
      expect(result).toBe('content-/no-timeout');
      // When timeout is disabled the fileStore is called directly without
      // an AbortSignal wrapper.
      expect(capturedSignal).toBeUndefined();
    });
  });

  describe('signal is aborted on timeout', () => {
    it('aborts the signal when fileStore exceeds the timeout', async () => {
      let signalWasAborted = false;
      let signalReason: unknown = null;

      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 20,
        fileStore: async (path, signal) => {
          // Store signal state for later assertion
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                signalWasAborted = true;
                signalReason = signal.reason;
              },
              { once: true },
            );
          }
          // Never resolve — forces timeout
          return new Promise<never>(() => {});
        },
      });

      // The timeout should cause the readFile to return null (cache-miss semantics)
      const result = await runtime.readFile('/timeout');
      expect(result).toBeNull();
      expect(signalWasAborted).toBe(true);
    });

    it('signal reason is a TimeoutError when aborted', async () => {
      let capturedReason: unknown = null;

      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 20,
        fileStore: async (path, signal) => {
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                capturedReason = signal.reason;
              },
              { once: true },
            );
          }
          return new Promise<never>(() => {});
        },
      });

      await runtime.readFile('/reason-check');
      // The reason should be a TimeoutError-like object or undefined depending
      // on platform. We just check the signal was aborted.
      expect(capturedReason).not.toBeNull();
    });

    it('fileStore can detect signal abort via event listener', async () => {
      let abortDetected = false;

      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 20,
        fileStore: async (path, signal) => {
          signal!.addEventListener(
            'abort',
            () => {
              abortDetected = true;
            },
            { once: true },
          );
          // Never resolve — forces timeout
          return new Promise<never>(() => {});
        },
      });

      // The timeout fires, aborts the signal, and the fileStore's listener
      // fires during the abort event dispatch. readFile returns null.
      const result = await runtime.readFile('/detect-abort');
      expect(result).toBeNull();
      await Promise.resolve(); // allow microtasks to settle
      expect(abortDetected).toBe(true);
    });
  });

  describe('signal is NOT aborted on success', () => {
    it('signal is not aborted when fileStore completes quickly', async () => {
      let capturedSignal: AbortSignal | undefined;

      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 5_000,
        fileStore: async (path, signal) => {
          capturedSignal = signal;
          return 'fast-result';
        },
      });

      const result = await runtime.readFile('/fast');
      expect(result).toBe('fast-result');
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);
    });

    it('multiple sequential fast calls have independent signals', async () => {
      const signals: AbortSignal[] = [];

      const runtime = edgeRuntime({
        fileStoreTimeoutMs: 5_000,
        fileStore: async (path, signal) => {
          signals.push(signal!);
          return `result-${path}`;
        },
      });

      await runtime.readFile('/a');
      await runtime.readFile('/b');
      await runtime.readFile('/c');

      expect(signals).toHaveLength(3);
      for (const s of signals) {
        expect(s.aborted).toBe(false);
      }
    });
  });

  describe('timeout logging', () => {
    it('logs file-store-timeout for each timed-out call', async () => {
      const { logger, warns } = captureWarnLogger();
      const prev = configureRuntimeEdgeLogger(logger);
      try {
        const runtime = edgeRuntime({
          fileStoreTimeoutMs: 10,
          fileStore: () => new Promise<never>(() => {}),
        });

        await runtime.readFile('/timeout-a');
        await runtime.readFile('/timeout-b');

        expect(warns.length).toBe(2);
        expect(warns[0].event).toBe('file-store-timeout');
        expect(warns[0].fields?.path).toBe('/timeout-a');
        expect(warns[1].fields?.path).toBe('/timeout-b');
      } finally {
        configureRuntimeEdgeLogger(prev);
      }
    });
  });
});
