import { describe, expect, test } from 'bun:test';
import {
  bunRuntime,
  configureRuntimeBunLogger,
  configureRuntimeBunStructuredLogger,
} from '../src/index';
import type { RuntimeBunLogger } from '../src/index';

/**
 * Tests for wrapFetch internals exercised through the public runtime API.
 * Each test mocks Bun.serve to capture the fetch handler that wrapFetch returns,
 * then drives it directly to verify error handling behavior.
 */

function captureFetchHandler(): (req: Request) => Response | Promise<Response> {
  let captured!: (req: Request) => Response | Promise<Response>;
  const originalServe = Bun.serve;
  Object.assign(Bun, {
    serve(opts: Record<string, unknown>) {
      captured = opts.fetch as typeof captured;
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
  // Return a restore function alongside the captured handler
  (captured as any).__restore = () => {
    Object.assign(Bun, { serve: originalServe });
  };
  return captured;
}

describe('fetch-wrapping', () => {
  test('normal response passthrough without error', async () => {
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
        fetch(req) {
          return new Response(`ok:${new URL(req.url).pathname}`);
        },
      });

      const res = await capturedFetch(new Request('http://localhost/hello'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok:/hello');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('sync throw in fetch handler forwards to opts.error', async () => {
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
      const errors: Error[] = [];
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw new Error('sync-boom');
        },
        error(err: Error) {
          errors.push(err);
          return new Response('caught', { status: 500 });
        },
      });

      const res = await capturedFetch(new Request('http://localhost/'));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('caught');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('sync-boom');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('async rejection in fetch handler forwards to opts.error', async () => {
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
      const errors: Error[] = [];
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        async fetch() {
          await Promise.resolve();
          throw new Error('async-boom');
        },
        error(err: Error) {
          errors.push(err);
          return new Response('async-caught', { status: 500 });
        },
      });

      const res = await capturedFetch(new Request('http://localhost/'));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('async-caught');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('async-boom');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('non-Error rejection is wrapped in an Error object', async () => {
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
      const errors: Error[] = [];
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw 'string-error-value';
        },
        error(err: Error) {
          errors.push(err);
          return new Response('wrapped', { status: 500 });
        },
      });

      await capturedFetch(new Request('http://localhost/'));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]!.message).toBe('string-error-value');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('without opts.error, fetch rejection returns 500 and logs via runtime logger', async () => {
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

    const loggedErrors: Array<{ phase?: string; message?: string }> = [];
    const customLogger: RuntimeBunLogger = {
      warn() {},
      error(_event, fields) {
        loggedErrors.push({
          phase: fields?.phase as string,
          message: fields?.message as string,
        });
      },
    };
    const prev = configureRuntimeBunLogger(customLogger);

    try {
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw new Error('no-error-handler');
        },
        // no opts.error
      });

      const res = await capturedFetch(new Request('http://localhost/'));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('Internal Server Error');
      expect(
        loggedErrors.some(e => e.phase === 'unhandled' && e.message === 'no-error-handler'),
      ).toBe(true);
    } finally {
      configureRuntimeBunLogger(prev);
      Object.assign(Bun, { serve: originalServe });
    }
  });

  test('null rejection is wrapped as Error with "null" message', async () => {
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
      const errors: Error[] = [];
      bunRuntime({ installProcessSafetyNet: false }).server.listen({
        port: 0,
        fetch() {
          throw null; // eslint-disable-line no-throw-literal
        },
        error(err: Error) {
          errors.push(err);
          return new Response('null-wrapped', { status: 500 });
        },
      });

      await capturedFetch(new Request('http://localhost/'));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('null');
    } finally {
      Object.assign(Bun, { serve: originalServe });
    }
  });
});
