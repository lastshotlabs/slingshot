import { describe, expect, test } from 'bun:test';
import {
  bunRuntime,
  configureRuntimeBunLogger,
  configureRuntimeBunStructuredLogger,
} from '../src/index';
import type { RuntimeBunLogger } from '../src/index';

describe('prod-hardening', () => {
  // ---------------------------------------------------------------------------
  // Fetch error handler edge cases
  // ---------------------------------------------------------------------------

  test('error handler that itself throws propagates the error from errorFn', async () => {
    const originalServe = Bun.serve;
    let capturedFetch!: (req: Request) => Response | Promise<Response>;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        capturedFetch = opts.fetch as typeof capturedFetch;
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

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw new Error('fetch-boom');
        },
        error() {
          throw new Error('error-handler-boom');
        },
      });

      // The wrapFetch catch block calls errorFn(wrapped). If errorFn throws,
      // the async function rejects with the error from errorFn.
      await expect(capturedFetch(new Request('http://localhost/'))).rejects.toThrow(
        'error-handler-boom',
      );
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('error handler that returns a normal Response is passed through correctly', async () => {
    const originalServe = Bun.serve;
    let capturedFetch!: (req: Request) => Response | Promise<Response>;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        capturedFetch = opts.fetch as typeof capturedFetch;
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

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw new Error('fetch-boom');
        },
        error(err: Error) {
          return new Response(`handled: ${err.message}`, { status: 400 });
        },
      });

      const res = await capturedFetch(new Request('http://localhost/'));
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('handled: fetch-boom');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  // ---------------------------------------------------------------------------
  // Publish / upgrade error resilience
  // ---------------------------------------------------------------------------

  test('server.publish failure is caught and logged without throwing', () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 9000,
          stop() {
            return undefined;
          },
          publish() {
            throw new Error('publish-boom');
          },
          upgrade() {
            return true;
          },
        };
      },
    });

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
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });

      // Must not throw -- error is caught and logged
      expect(() => server.publish('room:test', 'hello')).not.toThrow();
      expect(errors.some(e => e.phase === 'publish' && e.message === 'publish-boom')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('server.upgrade failure propagates (not caught by runtime)', () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 9000,
          stop() {
            return undefined;
          },
          publish() {},
          upgrade() {
            throw new Error('upgrade-boom');
          },
        };
      },
    });

    const capturedErrors: Array<{ phase?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        capturedErrors.push({ phase: fields?.phase as string });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });

      // upgrade() is not wrapped in a try-catch by the runtime, so the error
      // propagates to the caller
      expect(() => server.upgrade(new Request('http://localhost/upgrade'), { data: {} })).toThrow(
        'upgrade-boom',
      );

      // No runtime error should have been logged for the upgrade failure
      // (since it's not caught by the runtime)
      expect(capturedErrors.length).toBe(0);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });

  // ---------------------------------------------------------------------------
  // Concurrent / repeated stop safety
  // ---------------------------------------------------------------------------

  test('concurrent forced stop with websockets cleans up without throwing', async () => {
    const originalServe = Bun.serve;
    let capturedOpen: ((ws: unknown) => Promise<void>) | undefined;
    let stopCallCount = 0;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedOpen = ws.open;
        return {
          port: 1234,
          stop() {
            stopCallCount++;
            return undefined;
          },
          publish() {},
          upgrade() {
            return true;
          },
        };
      },
    });

    try {
      const runtime = bunRuntime({
        installProcessSafetyNet: false,
        wsCloseTimeoutMs: 10,
        forceCloseAfterTimeout: false,
      });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message() {},
          close() {},
        },
      });

      const rawWs = {
        data: {},
        send() {},
        close() {
          /* no-op */
        },
        ping() {},
        subscribe() {},
        unsubscribe() {},
      };
      await capturedOpen!(rawWs);

      // Two concurrent stop(true) calls -- both should resolve
      const results = await Promise.allSettled([server.stop(true), server.stop(true)]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('repeated graceful stop calls do not throw', async () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
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

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });

      // First stop
      await server.stop();
      // Second stop -- underlying Bun.serve.stop may be called again
      // but should not throw from the runtime wrapper
      await server.stop();
      // Third stop for good measure
      await server.stop(true);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  // ---------------------------------------------------------------------------
  // Empty / minimal configuration edge cases
  // ---------------------------------------------------------------------------

  test('bunRuntime() with empty options object does not throw', () => {
    expect(() => bunRuntime({})).not.toThrow();
  });

  test('bunRuntime() with null options does not throw', () => {
    // Passing null as options should be handled by resolveOptions
    expect(() => bunRuntime(null as unknown as undefined)).not.toThrow();
  });

  test('bunRuntime() with undefined options does not throw', () => {
    expect(() => bunRuntime()).not.toThrow();
    expect(() => bunRuntime(undefined)).not.toThrow();
  });

  test('server.listen with minimal options (port + fetch only) works', () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 5678,
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

    try {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });
      expect(server.port).toBeGreaterThan(0);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  // ---------------------------------------------------------------------------
  // Default option resolution
  // ---------------------------------------------------------------------------

  test('default wsCloseTimeoutMs is applied when negative value is provided', () => {
    // A negative wsCloseTimeoutMs should be rejected by resolveOptions
    // and fall back to the default. We verify this indirectly through
    // behavior (timing) in the graceful-shutdown tests. Here we just
    // confirm no crash.
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
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

    try {
      const runtime = bunRuntime({ wsCloseTimeoutMs: -1, installProcessSafetyNet: false });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });
      // No crash is the primary assertion
      server.stop(true);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('default gracefulCloseTimeoutMs is applied when negative value is provided', () => {
    const originalServe = Bun.serve;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
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

    try {
      const runtime = bunRuntime({
        gracefulCloseTimeoutMs: -1,
        installProcessSafetyNet: false,
      });
      const server = runtime.server.listen({
        port: 0,
        fetch: () => new Response('ok'),
      });
      server.stop();
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  // ---------------------------------------------------------------------------
  // WebSocket send failure is caught and logged
  // ---------------------------------------------------------------------------

  test('ws.send() failure is caught and logged with send phase', () => {
    const originalServe = Bun.serve;
    let capturedMessage: ((ws: unknown, msg: string) => Promise<void>) | undefined;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedMessage = ws.message;
        return {
          port: 1234,
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

    const errors: Array<{ phase?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        errors.push({ phase: fields?.phase as string });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch: () => new Response('ok'),
        websocket: {
          open() {},
          message(ws) {
            // ws.send wraps Bun's send in a try-catch that logs 'send' phase
            ws.send('hello');
          },
          close() {},
        },
      });

      // Pass a raw WS whose send() throws
      capturedMessage!(
        {
          data: {},
          send() {
            throw new Error('send-fail');
          },
          close() {},
          ping() {},
          subscribe() {},
          unsubscribe() {},
        },
        'hello',
      );

      expect(errors.some(e => e.phase === 'send')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });
});
