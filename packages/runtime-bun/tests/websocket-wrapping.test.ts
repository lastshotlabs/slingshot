import { describe, expect, test } from 'bun:test';
import { bunRuntime, configureRuntimeBunLogger } from '../src/index';
import type { RuntimeBunLogger } from '../src/index';

/**
 * Tests for wrapWebSocketHandler exercised through the public runtime API.
 * Each test mocks Bun.serve to capture the websocket lifecycle callbacks,
 * then invokes them directly to verify error wrapping behavior.
 */

function captureWebSocketLifecycle(): {
  open: (ws: unknown) => Promise<void>;
  message: (ws: unknown, msg: string) => Promise<void>;
  close: (ws: unknown, code: number, reason: string) => Promise<void>;
  pong: ((ws: unknown) => void) | undefined;
  restore: () => void;
} {
  const captured: any = {};
  const originalServe = Bun.serve;
  Object.assign(Bun, {
    serve(opts: Record<string, unknown>) {
      const ws = (opts.websocket ?? {}) as any;
      captured.open = ws.open;
      captured.message = ws.message;
      captured.close = ws.close;
      captured.pong = ws.pong;
      return {
        port: 0,
        stop() {
          return undefined;
        },
        publish() {},
        upgrade() {
          return true;
        },
      };
    },
  });
  // Use getters so callers always read the latest captured values
  // instead of stale values from when this function returned.
  return {
    get open() {
      return captured.open;
    },
    get message() {
      return captured.message;
    },
    get close() {
      return captured.close;
    },
    get pong() {
      return captured.pong;
    },
    restore: () => {
      Object.assign(Bun, { serve: originalServe });
    },
  };
}

describe('websocket-wrapping', () => {
  test('open lifecycle error is logged with open phase context', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {
            throw new Error('open-boom');
          },
          message() {},
          close() {},
        },
      });

      await lifecycle.open({ data: {} });
      expect(errors.some(e => e.phase === 'open' && e.message === 'open-boom')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('message lifecycle error is logged with message phase context', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {
            throw new Error('message-boom');
          },
          close() {},
        },
      });

      await lifecycle.message({ data: {} }, 'hello');
      expect(errors.some(e => e.phase === 'message' && e.message === 'message-boom')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('close lifecycle error is logged with close phase', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {},
          close() {
            throw new Error('close-boom');
          },
        },
      });

      await lifecycle.close({ data: {} }, 1000, 'normal');
      expect(errors.some(e => e.phase === 'close' && e.message === 'close-boom')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('close handler resolves deferred even when user handler throws', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({
        installProcessSafetyNet: false,
        wsCloseTimeoutMs: 50,
        forceCloseAfterTimeout: false,
      }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {},
          close() {
            throw new Error('close-deferred-test');
          },
        },
      });

      // Simulate open -> close sequence. When close throws, the deferred should
      // still resolve so the drain doesn't hang on this socket.
      await lifecycle.open({ data: {} });
      await lifecycle.close({ data: {} }, 1001, 'Server shutting down');

      expect(errors.some(e => e.phase === 'close' && e.message === 'close-deferred-test')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('pong lifecycle error is logged with pong phase', () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {},
          close() {},
          pong() {
            throw new Error('pong-boom');
          },
        },
      });

      lifecycle.pong!({ data: {} });
      expect(errors.some(e => e.phase === 'pong' && e.message === 'pong-boom')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('missing pong handler is left undefined (not called)', () => {
    const lifecycle = captureWebSocketLifecycle();

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {},
          close() {},
          // no pong handler
        },
      });

      expect(lifecycle.pong).toBeUndefined();
    } finally {
      lifecycle.restore();
    }
  });

  test('non-Error throw in message is caught and logged with string message', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({ message: fields?.message as string });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {
            throw 42; // eslint-disable-line no-throw-literal
          },
          close() {},
        },
      });

      await lifecycle.message({ data: {} }, 'hello');
      expect(errors.some(e => e.message === '42')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });

  test('undefined throw in open is caught and logged as "undefined"', async () => {
    const lifecycle = captureWebSocketLifecycle();
    const errors: Array<{ message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({ message: fields?.message as string });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {
            throw undefined; // eslint-disable-line no-throw-literal
          },
          message() {},
          close() {},
        },
      });

      await lifecycle.open({ data: {} });
      expect(errors.some(e => e.message === 'undefined')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      lifecycle.restore();
    }
  });
});
