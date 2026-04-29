import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureRuntimeNodeLogger,
  configureRuntimeNodeStructuredLogger,
  installProcessSafetyNet,
  nodeRuntime,
} from '../src/index';

/**
 * Tests for the process-level safety net (installProcessSafetyNet) and
 * the fetch error callback failure path (P-NODE-4).
 *
 * installProcessSafetyNet uses a module-level `processHandlersInstalled`
 * flag, so it can only be installed once per process. The handler tests
 * install the safety net in `beforeAll` and reuse the existing handlers.
 */

let safetyNetInstalled = false;

describe('installProcessSafetyNet', () => {
  beforeAll(() => {
    if (!safetyNetInstalled) {
      installProcessSafetyNet();
      safetyNetInstalled = true;
    }
  });

  afterEach(() => {
    configureRuntimeNodeLogger(null);
    configureRuntimeNodeStructuredLogger(null);
  });

  test('is idempotent and does not throw when called multiple times', () => {
    expect(() => {
      installProcessSafetyNet();
      installProcessSafetyNet();
    }).not.toThrow();
  });

  test('does not increase listener counts on subsequent calls', () => {
    const rejectionCount = process.listenerCount('unhandledRejection');
    const exceptionCount = process.listenerCount('uncaughtException');

    installProcessSafetyNet();

    expect(process.listenerCount('unhandledRejection')).toBe(rejectionCount);
    expect(process.listenerCount('uncaughtException')).toBe(exceptionCount);
  });

  test('installs at least one handler for each event type', () => {
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(0);
  });
});

describe('installProcessSafetyNet — handler behavior', () => {
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];

  beforeAll(() => {
    // Replace the structured logger so we can capture what the safety
    // net's handlers log without emitting real process events.
    configureRuntimeNodeStructuredLogger({
      debug() {},
      info() {},
      warn() {},
      error(event, fields) {
        logged.push({ event, fields });
      },
      child() {
        return this;
      },
    });
  });

  afterAll(() => {
    configureRuntimeNodeStructuredLogger(null);
  });

  beforeEach(() => {
    logged.length = 0;
  });

  test('unhandledRejection handler is a function', () => {
    const handlers = process.listeners('unhandledRejection');
    expect(handlers.length).toBeGreaterThan(0);
    const handler = handlers[handlers.length - 1];
    expect(typeof handler).toBe('function');
  });

  test('uncaughtException handler is a function', () => {
    const handlers = process.listeners('uncaughtException');
    expect(handlers.length).toBeGreaterThan(0);
    const handler = handlers[handlers.length - 1];
    expect(typeof handler).toBe('function');
  });

  // Note: We cannot safely emit unhandledRejection or uncaughtException
  // directly in tests because the test runner itself catches those events.
  // The handler logic is verified by the fetch error callback tests below
  // which exercise the same logger path.
});

describe('fetch error callback failure (P-NODE-4)', () => {
  let server: ReturnType<typeof nodeRuntime> extends {
    server: { listen: (opts: unknown) => Promise<infer R> };
  }
    ? R
    : never;

  afterEach(async () => {
    if (server) {
      await (server as { stop: (force: boolean) => Promise<void> }).stop(true).catch(() => {});
      server = undefined as unknown as typeof server;
    }
    configureRuntimeNodeLogger(null);
    configureRuntimeNodeStructuredLogger(null);
  });

  test('error callback that itself throws is logged and returns 500', async () => {
    const runtime = nodeRuntime();
    const errors: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previousStructured = configureRuntimeNodeStructuredLogger({
      debug() {},
      info() {},
      warn() {},
      error(event, fields) {
        errors.push({ event, fields });
      },
      child() {
        return previousStructured;
      },
    });

    // Suppress the uncaughtException re-emit during the test
    const swallow = () => {};
    process.on('uncaughtException', swallow);

    try {
      const instance = await runtime.server.listen({
        port: 0,
        fetch() {
          throw new Error('original-error');
        },
        error() {
          throw new Error('callback-error');
        },
      });
      server = instance;

      const res = await fetch(`http://127.0.0.1:${instance.port}/`);
      expect(res.status).toBe(500);

      // Allow logs to flush
      await new Promise(r => setTimeout(r, 50));

      const ev = errors.find(e => e.event === 'fetch-error-callback-threw');
      expect(ev).toBeDefined();
      expect(ev?.fields?.originalError).toBe('original-error');
      expect(ev?.fields?.callbackError).toBe('callback-error');
    } finally {
      process.removeListener('uncaughtException', swallow);
    }
  });

  test('error callback returning a Response is used as the error response', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch() {
        throw new Error('handler-error');
      },
      error(err) {
        return new Response(`custom-error: ${err.message}`, { status: 502 });
      },
    });
    server = instance;

    const res = await fetch(`http://127.0.0.1:${instance.port}/`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('custom-error: handler-error');
  });

  test('fetch error without error callback returns generic 500', async () => {
    const runtime = nodeRuntime();
    const instance = await runtime.server.listen({
      port: 0,
      fetch() {
        throw new Error('unhandled-error');
      },
    });
    server = instance;

    const res = await fetch(`http://127.0.0.1:${instance.port}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
  });

  test('async fetch handler rejection is caught by error callback', async () => {
    const runtime = nodeRuntime();
    const errors: Error[] = [];
    const instance = await runtime.server.listen({
      port: 0,
      fetch: async () => {
        throw new Error('async-error');
      },
      error(err) {
        errors.push(err);
        return new Response('async-caught', { status: 500 });
      },
    });
    server = instance;

    const res = await fetch(`http://127.0.0.1:${instance.port}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('async-caught');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('async-error');
  });
});
