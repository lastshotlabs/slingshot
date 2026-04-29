import { describe, expect, test } from 'bun:test';
import {
  bunRuntime,
  configureRuntimeBunLogger,
  configureRuntimeBunStructuredLogger,
} from '../src/index';
import type { RuntimeBunLogger } from '../src/index';
import type { Logger } from '@lastshotlabs/slingshot-core';

describe('graceful-shutdown', () => {
  test('forced stop without websockets calls server.stop(true) and resolves', async () => {
    const originalServe = Bun.serve;
    let stopCloseValue: boolean | undefined;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
          stop(close?: boolean) {
            stopCloseValue = close;
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

      await server.stop(true);
      expect(stopCloseValue).toBe(true);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('graceful stop without websockets calls server.stop(false) and resolves', async () => {
    const originalServe = Bun.serve;
    let stopCloseValue: boolean | undefined;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
          stop(close?: boolean) {
            stopCloseValue = close;
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

      await server.stop(); // graceful (no argument)
      expect(stopCloseValue).toBe(false);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('forceCloseAfterTimeout=false prevents force-stop when close handler stalls', async () => {
    const originalServe = Bun.serve;
    let stopInvoked = false;
    let capturedOpen: ((ws: unknown) => Promise<void>) | undefined;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedOpen = ws.open;
        return {
          port: 1234,
          stop() {
            stopInvoked = true;
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

      // Register a WS whose close() does not dispatch the lifecycle handler
      const rawWs = {
        data: {},
        send() {},
        close() {
          /* no-op -- close handler never fires */
        },
        ping() {},
        subscribe() {},
        unsubscribe() {},
      };
      await capturedOpen!(rawWs);

      // Forced stop with timeout. Since forceCloseAfterTimeout=false and the
      // handler won't fire, server.stop(true) should NOT be called.
      await server.stop(true);
      expect(stopInvoked).toBe(false);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('BUN_STOP_GRACE_MS race prevents hang when server.stop(true) never resolves', async () => {
    const originalServe = Bun.serve;
    let capturedOpen: ((ws: unknown) => Promise<void>) | undefined;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedOpen = ws.open;
        return {
          port: 1234,
          stop() {
            // Return a promise that never settles
            return new Promise<void>(() => {});
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

      // Register a WS to trigger the drain + stop(true) race path
      const rawWs = {
        data: {},
        send() {},
        close() {
          /* no-op -- handler never fires, so timeout branches to force-stop */
        },
        ping() {},
        subscribe() {},
        unsubscribe() {},
      };
      await capturedOpen!(rawWs);

      // stop(true) should resolve despite server.stop(true) hanging indefinitely.
      // The runtime's race with BUN_STOP_GRACE_MS (50 ms) should win.
      const start = Date.now();
      await server.stop(true);
      const elapsed = Date.now() - start;
      // 10ms WS timeout + 50ms grace = ~60ms; anything under 2s confirms the race works
      expect(elapsed).toBeLessThan(2000);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('concurrent stop(true) calls both resolve without throwing', async () => {
    const originalServe = Bun.serve;
    const callOrder: string[] = [];
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
          stop(close?: boolean) {
            callOrder.push(`stop:${String(close)}`);
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

      const [a, b] = await Promise.all([server.stop(true), server.stop(true)]);
      // Both should resolve without throwing
      expect(callOrder.filter(c => c === 'stop:true').length).toBe(2);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('forced stop with websocket close error logs phase and cleans up', async () => {
    const originalServe = Bun.serve;
    let capturedOpen: ((ws: unknown) => Promise<void>) | undefined;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedOpen = ws.open;
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

      // WS whose close() throws
      const rawWs = {
        data: {},
        send() {},
        close() {
          throw new Error('close-throw');
        },
        ping() {},
        subscribe() {},
        unsubscribe() {},
      };
      await capturedOpen!(rawWs);

      await server.stop(true);

      // The runtime catches the close error and logs it with 'shutdown-close' phase
      expect(errors.some(e => e.phase === 'shutdown-close' && e.message === 'close-throw')).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('graceful stop with websocket close error logs and continues', async () => {
    const originalServe = Bun.serve;
    let capturedOpen: ((ws: unknown) => Promise<void>) | undefined;
    Object.assign(Bun, {
      serve(opts: Record<string, unknown>) {
        const ws = (opts.websocket ?? {}) as any;
        capturedOpen = ws.open;
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
      const runtime = bunRuntime({
        installProcessSafetyNet: false,
        gracefulCloseTimeoutMs: 50,
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

      // WS whose close() throws -- graceful stop path catches and logs
      const rawWs = {
        data: {},
        send() {},
        close() {
          throw new Error('graceful-close-throw');
        },
        ping() {},
        subscribe() {},
        unsubscribe() {},
      };
      await capturedOpen!(rawWs);

      await server.stop(); // graceful

      expect(
        errors.some(
          e => e.phase === 'graceful-shutdown-close' && e.message === 'graceful-close-throw',
        ),
      ).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('graceful stop without websockets completes via Promise.resolve', async () => {
    // Verify that the stop(false) with empty activeSockets calls
    // Promise.resolve(server.stop(false)) and awaits it.
    const originalServe = Bun.serve;
    let stopResolved = false;
    Object.assign(Bun, {
      serve() {
        return {
          port: 1234,
          stop() {
            // Return a plain value (not a promise) to check wrapping
            stopResolved = true;
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

      await server.stop();
      expect(stopResolved).toBe(true);
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });
});
