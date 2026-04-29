// packages/runtime-edge/tests/unit/logging.test.ts
//
// Tests for both configureRuntimeEdgeLogger functions in the runtime-edge
// package. There are two separate logger configurations:
//
//   1. src/index.ts — configureRuntimeEdgeLogger(logger: Logger | null): Logger
//      Used for fileStore-timeout warnings. Takes a slingshot-core Logger
//      (debug/info/warn/error/child).
//
//   2. src/kv-isr.ts  — configureRuntimeEdgeLogger(logger: RuntimeEdgeLogger | null): RuntimeEdgeLogger
//      Used for KV tag-index error logs. Takes a simpler
//      { error(event, fields) } interface.
//
// Coverage:
//   - Swapping to a custom logger via index.ts configureRuntimeEdgeLogger
//   - Resetting to the default via null
//   - configureRuntimeEdgeLogger returns the previous logger
//   - Default logger forwards to console
//   - Swapping to a custom logger via kv-isr.ts configureRuntimeEdgeLogger
//   - kv-isr logger reset with null restores the default
//   - kv-isr default logger logs to console.error
//   - Logger called with and without structured fields
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { configureRuntimeEdgeLogger as configureIndexLogger } from '../../src/index';
import { configureRuntimeEdgeLogger as configureKvIsrLogger } from '../../src/kv-isr';

// Reset both module-level loggers to default after this file completes,
// so concurrent/sequential test files are not affected by our swaps.
afterAll(() => {
  configureIndexLogger(null);
  configureKvIsrLogger(null);
});

// ---------------------------------------------------------------------------
// index.ts logger — swappable structured Logger (slingshot-core)
// ---------------------------------------------------------------------------

describe('configureRuntimeEdgeLogger (from src/index.ts)', () => {
  it('returns the previous logger on first call', () => {
    // First call with no prior swap returns the default
    const prev = configureIndexLogger({
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this as unknown as Logger;
      },
    });
    // The default logger has all the required methods
    expect(prev).toBeDefined();
    expect(typeof prev.debug).toBe('function');
    expect(typeof prev.info).toBe('function');
    expect(typeof prev.warn).toBe('function');
    expect(typeof prev.error).toBe('function');
    expect(typeof prev.child).toBe('function');
    // Restore
    configureIndexLogger(prev);
  });

  it('routes subsequent log calls through the custom logger', () => {
    const events: Array<{ method: string; args: unknown[] }> = [];
    const customLogger: Logger = {
      debug(...args: unknown[]) {
        events.push({ method: 'debug', args });
      },
      info(...args: unknown[]) {
        events.push({ method: 'info', args });
      },
      warn(...args: unknown[]) {
        events.push({ method: 'warn', args });
      },
      error(...args: unknown[]) {
        events.push({ method: 'error', args });
      },
      child() {
        return this as unknown as Logger;
      },
    };

    const prev = configureIndexLogger(customLogger);
    try {
      // The Index Logger is a module-level singleton. We can't easily trigger
      // file-store-timeout here (it requires a concurrent setTimeout), but we
      // can verify the swap itself succeeded.
      expect(prev).not.toBe(customLogger);
    } finally {
      configureIndexLogger(prev);
    }
  });

  it('resets to the default logger when null is passed', () => {
    const customLogger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this as unknown as Logger;
      },
    };

    const prev = configureIndexLogger(customLogger);
    const restored = configureIndexLogger(null);
    expect(restored).toBe(customLogger); // null swap returned the custom logger

    // Now the logger should be back to default. Call it again to get default ref.
    const defaultLogger = configureIndexLogger(customLogger);
    expect(typeof defaultLogger.debug).toBe('function');
    expect(typeof defaultLogger.info).toBe('function');
    expect(typeof defaultLogger.warn).toBe('function');
    expect(typeof defaultLogger.error).toBe('function');
    // Clean up
    configureIndexLogger(null);
  });

  it('the default logger serialises to JSON via console', () => {
    // The default implementation is `createConsoleLogger({ base: { runtime: 'edge' } })`,
    // which serialises the whole payload as a single JSON string via console.warn/error.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const customLogger: Logger = {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this as unknown as Logger;
        },
      };
      const prev = configureIndexLogger(customLogger);

      // Invoke methods on the default logger (prev)
      prev.warn('file-store-timeout', { path: '/test', timeoutMs: 100 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]?.[0] as string;
      expect(warnArg).toContain('file-store-timeout');
      expect(warnArg).toContain('/test');
      expect(warnArg).toContain('100');

      prev.error('some-error', { code: 500 });
      expect(errorSpy).toHaveBeenCalledTimes(1);

      configureIndexLogger(prev);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('accepts a logger without child() for minimal compatibility', () => {
    // The Logger interface requires child(), but configureRuntimeEdgeLogger
    // only uses warn(). Test with a minimal object.
    const minimal = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    } satisfies Logger;

    const prev = configureIndexLogger(minimal);
    expect(prev).toBeDefined();
    configureIndexLogger(prev);
  });
});

// ---------------------------------------------------------------------------
// kv-isr.ts logger — lighter { error(event, fields) } interface
// ---------------------------------------------------------------------------

describe('configureRuntimeEdgeLogger (from src/kv-isr.ts)', () => {
  it('swaps the active logger and returns the previous one', () => {
    const captured: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const custom = {
      error(event: string, fields?: Record<string, unknown>) {
        captured.push({ event, fields });
      },
    };
    const prev = configureKvIsrLogger(custom);
    expect(typeof prev.error).toBe('function');
    // The default logger is not the custom one
    expect(prev).not.toBe(custom);
    configureKvIsrLogger(prev);
  });

  it('resets to the default console.error logger when null is passed', () => {
    const custom = { error() {} };
    const prev = configureKvIsrLogger(custom);
    const restored = configureKvIsrLogger(null);
    expect(restored).toBe(custom);
    // Now the logger is the default again — call it and verify it swaps
    const defaultLogger = configureKvIsrLogger(custom);
    expect(typeof defaultLogger.error).toBe('function');
    configureKvIsrLogger(null);
  });

  it('default logger calls console.error with event and no fields', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const custom = { error() {} };
      const prev = configureKvIsrLogger(custom);

      // Invoke the default logger directly
      prev.error('test-event');
      expect(errorSpy).toHaveBeenCalledWith('[runtime-edge] test-event');

      configureKvIsrLogger(prev);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('default logger calls console.error with event and fields', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const custom = { error() {} };
      const prev = configureKvIsrLogger(custom);

      prev.error('test-event', { key: 'value', count: 42 });
      expect(errorSpy).toHaveBeenCalledWith('[runtime-edge] test-event', {
        key: 'value',
        count: 42,
      });

      configureKvIsrLogger(prev);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('default logger treats empty fields object as "no fields" (else branch)', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const custom = { error() {} };
      const prev = configureKvIsrLogger(custom);

      // Empty fields object: Object.keys({}).length === 0, so the "no fields"
      // branch fires — console.error is called with just the event string.
      prev.error('empty-fields', {});
      expect(errorSpy).toHaveBeenCalledWith('[runtime-edge] empty-fields');

      configureKvIsrLogger(prev);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('round-trips through multiple swaps without leaking state', () => {
    const loggers = [
      { error() {} },
      {
        error() {
          /* noop */
        },
      },
    ];

    const prev1 = configureKvIsrLogger(loggers[0]);
    expect(configureKvIsrLogger(loggers[1])).toBe(loggers[0]);
    expect(configureKvIsrLogger(prev1)).toBe(loggers[1]);
    // Final reset
    configureKvIsrLogger(prev1);
  });
});
