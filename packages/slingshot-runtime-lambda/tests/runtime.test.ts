import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotContext, SlingshotHandler } from '@lastshotlabs/slingshot-core';
import { createDefaultIdentityResolver } from '@lastshotlabs/slingshot-core';

const runtimeState = {
  bootstrapCalls: 0,
  ctx: null as SlingshotContext | null,
  teardown: mock(async () => {}),
};

mock.module('../src/bootstrap', () => ({
  bootstrap: async () => {
    runtimeState.bootstrapCalls += 1;
    return {
      ctx: runtimeState.ctx,
      teardown: runtimeState.teardown,
    };
  },
}));

function createContextFixture(): SlingshotContext {
  return {
    app: {},
    appName: 'test-app',
    config: {},
    redis: null,
    mongo: null,
    sqlite: null,
    sqliteDb: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    wsEndpoints: null,
    wsPublish: null,
    persistence: {
      idempotency: {
        async get() {
          return null;
        },
        async set() {},
      },
      auditLog: {
        async logEntry() {},
        async getLogs() {
          return { items: [] };
        },
      },
    },
    pluginState: new Map(),
    publicPaths: new Set(),
    plugins: [],
    bus: {
      emit() {},
      on() {},
      off() {},
    },
    adapters: {},
    routeAuth: null,
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
    rateLimitAdapter: {
      async trackAttempt() {
        return false;
      },
    },
    fingerprintBuilder: {
      async buildFingerprint() {
        return 'fp';
      },
    },
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    upload: null,
    metrics: {
      counters: new Map(),
      histograms: new Map(),
      gaugeCallbacks: new Map(),
      queues: null,
    },
    secrets: {},
    resolvedSecrets: {},
    async clear() {},
    async destroy() {},
  } as unknown as SlingshotContext;
}

function createHandler(
  impl: (input: unknown, meta: Record<string, unknown>) => Promise<unknown>,
): SlingshotHandler {
  return {
    name: 'runtime.test',
    input: z.any(),
    output: z.any(),
    guards: [],
    after: [],
    async invoke(raw: unknown, opts: { meta?: Record<string, unknown> }) {
      return impl(raw, opts.meta ?? {});
    },
  };
}

describe('createLambdaRuntime', () => {
  beforeEach(() => {
    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();
    runtimeState.teardown = mock(async () => {});
  });

  test('bootstraps once, calls onInit once, and marks warm invocations after the first call', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const coldStarts: boolean[] = [];
    const handlerMeta: string[] = [];
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      hooks: {
        async onInit() {
          handlerMeta.push('init');
        },
        beforeInvoke(args) {
          coldStarts.push(args.isColdStart);
          return undefined;
        },
      },
    });

    const handler = createHandler(async (_input, meta) => {
      handlerMeta.push(String(meta['correlationId']));
      return { ok: true };
    });

    const wrapped = runtime.wrap(handler, 'schedule');
    await wrapped({ id: 'sched-1', time: '2026-04-19T00:00:00Z', detail: { ok: true } }, {});
    await wrapped({ id: 'sched-2', time: '2026-04-20T00:00:00Z', detail: { ok: true } }, {});

    expect(runtimeState.bootstrapCalls).toBe(1);
    expect(coldStarts).toEqual([true, false]);
    expect(handlerMeta[0]).toBe('init');
    expect(handlerMeta).toContain('sched-1');
    expect(handlerMeta).toContain('sched-2');
  });

  test('tears down a failed bootstrap and retries on the next access', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    let failOnInit = true;
    const onInit = mock(async () => {
      if (failOnInit) {
        failOnInit = false;
        throw new Error('init failed');
      }
    });
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      hooks: { onInit },
    });

    await expect(runtime.getContext()).rejects.toThrow('init failed');
    expect(runtimeState.teardown).toHaveBeenCalledTimes(1);

    const expectedCtx = runtimeState.ctx;
    if (expectedCtx == null) {
      throw new Error('test bootstrap did not install a context fixture');
    }

    const ctx = await runtime.getContext();
    expect(ctx).toBe(expectedCtx);
    expect(runtimeState.bootstrapCalls).toBe(2);
    expect(onInit).toHaveBeenCalledTimes(2);
  });

  test('shutdown calls onShutdown and tears down the cached app context', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const onShutdown = mock(async () => {});
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      hooks: { onShutdown },
    });

    await runtime.getContext();
    await runtime.shutdown();

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(runtimeState.teardown).toHaveBeenCalledTimes(1);
  });

  test('registers a SIGTERM listener when onShutdown is configured', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const onShutdown = mock(async () => {});
    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: { onShutdown },
      });

      await runtime.getContext();

      expect(onceSpy).toHaveBeenCalled();
      expect(capturedListener).toBeDefined();

      capturedListener?.();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      onceSpy.mockRestore();
    }
  });

  test('SIGTERM swallows synchronous throws from onShutdown without unhandled rejection', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { configureRuntimeLogger } = await import('../src/runtime');
    const previous = configureRuntimeLogger({
      debug() {},
      info() {},
      warn() {},
      error(event, fields) {
        events.push({ event, fields });
      },
      child(): typeof previous {
        return previous;
      },
    });
    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: {
          onShutdown() {
            // Synchronous throw — must not bubble out as unhandled.
            throw new Error('sync-throw-from-shutdown');
          },
        },
      });
      await runtime.getContext();
      capturedListener?.();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events.some(e => e.event === 'onShutdown-hook-threw')).toBe(true);
    } finally {
      onceSpy.mockRestore();
      configureRuntimeLogger(previous);
    }
  });

  test('SIGTERM swallows asynchronous rejections from onShutdown', async () => {
    const { createLambdaRuntime, configureRuntimeLogger } = await import('../src/runtime');

    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLogger({
      debug() {},
      info() {},
      warn() {},
      error(event, fields) {
        events.push({ event, fields });
      },
      child(): typeof previous {
        return previous;
      },
    });
    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: {
          async onShutdown() {
            await Promise.resolve();
            throw new Error('async-throw-from-shutdown');
          },
        },
      });
      await runtime.getContext();
      capturedListener?.();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events.some(e => e.event === 'onShutdown-hook-threw')).toBe(true);
    } finally {
      onceSpy.mockRestore();
      configureRuntimeLogger(previous);
    }
  });

  test('shutdown() swallows onShutdown rejection and still tears down', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: {
          async onShutdown() {
            throw new Error('shutdown-fail');
          },
        },
      });
      await runtime.getContext();
      await runtime.shutdown(); // must not throw
      expect(runtimeState.teardown).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('wrap() validates trigger kind eagerly', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });
    const handler = createHandler(async () => ({ ok: true }));
    expect(() => runtime.wrap(handler, 'not-a-trigger' as never)).toThrow(
      /Unsupported Lambda trigger/,
    );
  });

  test('SIGTERM does not hang when onShutdown exceeds shutdownTimeoutMs', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    let shutdownResolved = false;
    const onShutdown = mock(async () => {
      await new Promise(resolve => setTimeout(resolve, 200)); // outlasts timeout
      shutdownResolved = true;
    });

    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: { onShutdown },
        shutdownTimeoutMs: 10, // very short timeout
      });

      await runtime.getContext();
      capturedListener?.();

      // Wait slightly beyond the timeout but well short of onShutdown's 200ms
      await new Promise(resolve => setTimeout(resolve, 30));

      // onShutdown was called but hasn't resolved yet — timeout won
      expect(onShutdown).toHaveBeenCalledTimes(1);
      expect(shutdownResolved).toBe(false);
    } finally {
      onceSpy.mockRestore();
    }
  });

  // P-LAMBDA-1 — SIGTERM tracks in-flight invocations and awaits them.
  test('SIGTERM awaits in-flight invocations before running onShutdown (P-LAMBDA-1)', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();

    let invocationStarted!: () => void;
    const startedSignal = new Promise<void>(resolve => {
      invocationStarted = resolve;
    });
    let releaseInvocation!: () => void;
    const release = new Promise<void>(resolve => {
      releaseInvocation = resolve;
    });

    let onShutdownCalledAfterDrain = false;
    let onShutdownCalledAt = 0;
    const onShutdown = mock(async () => {
      onShutdownCalledAt = Date.now();
      onShutdownCalledAfterDrain = true;
    });

    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        hooks: { onShutdown },
        shutdownDrainMs: 1_000,
      });
      const handler = createHandler(async () => {
        invocationStarted();
        await release;
        return { ok: true };
      });
      const wrapped = runtime.wrap(handler, 'schedule');

      // Kick off an invocation but don't await it yet.
      const invocationPromise = wrapped({}, { awsRequestId: 'req-1' });
      // Wait until the handler has actually started.
      await startedSignal;

      // Fire SIGTERM. The drain should wait for the invocation to settle
      // before running onShutdown.
      const sigStart = Date.now();
      capturedListener?.();
      // Hold the invocation for 60ms so the drain has to wait.
      await new Promise(r => setTimeout(r, 60));
      releaseInvocation();
      await invocationPromise;

      // Allow the SIGTERM continuation to run.
      await new Promise(r => setTimeout(r, 60));
      expect(onShutdownCalledAfterDrain).toBe(true);
      expect(onShutdownCalledAt).toBeGreaterThan(sigStart + 50);
    } finally {
      onceSpy.mockRestore();
    }
  });

  // P-LAMBDA-1 — SIGTERM logs warn when drain timeout is exceeded.
  test('SIGTERM logs structured warn when shutdownDrainMs is exceeded', async () => {
    const { createLambdaRuntime, configureRuntimeLogger } = await import('../src/runtime');
    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();

    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLogger({
      debug() {},
      info() {},
      warn(event, fields) {
        events.push({ event, fields });
      },
      error() {},
      child(): typeof previous {
        return previous;
      },
    });

    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });

    let capturedListener: (() => void) | undefined;
    const onceSpy = spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'SIGTERM') {
        capturedListener = listener as () => void;
      }
      return process;
    }) as typeof process.once);

    try {
      const runtime = createLambdaRuntime({
        manifest: { manifestVersion: 1 },
        shutdownDrainMs: 30,
      });
      const handler = createHandler(async () => {
        await held;
        return { ok: true };
      });
      const wrapped = runtime.wrap(handler, 'schedule');
      const invocationPromise = wrapped({}, { awsRequestId: 'req-2' });

      // Give the handler time to enter the inflight set.
      await new Promise(r => setTimeout(r, 20));
      capturedListener?.();
      // Wait past the drain window.
      await new Promise(r => setTimeout(r, 80));
      // Release so the test can clean up.
      release();
      await invocationPromise;

      expect(events.some(e => e.event === 'shutdown-drain-timeout')).toBe(true);
    } finally {
      onceSpy.mockRestore();
      configureRuntimeLogger(previous);
    }
  });

  // P-LAMBDA-5 — bootstrap failure flips coldStart and sets bootstrapError.
  test('bootstrap failure sets coldStart=false and bootstrapError=true (P-LAMBDA-5)', async () => {
    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = null; // signals bootstrap success path returns null ctx
    // Override the bootstrap module to throw on first call, succeed on second.
    let calls = 0;
    mock.module('../src/bootstrap', () => ({
      bootstrap: async () => {
        calls += 1;
        if (calls === 1) throw new Error('bootstrap-fail');
        return { ctx: createContextFixture(), teardown: async () => {} };
      },
    }));

    const { createLambdaRuntime } = await import('../src/runtime');
    type RuntimeWithInternals = ReturnType<typeof createLambdaRuntime> & {
      _internals: { coldStart: boolean; bootstrapError: boolean };
    };
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
    }) as RuntimeWithInternals;

    // First call — bootstrap throws.
    await expect(runtime.getContext()).rejects.toThrow('bootstrap-fail');
    expect(runtime._internals.coldStart).toBe(false);
    expect(runtime._internals.bootstrapError).toBe(true);

    // Second call — bootstrap succeeds; bootstrapError stays true until the
    // first successful invocation completes.
    await runtime.getContext();
    // bootstrapError clears in ensureBootstrap on bootstrap success.
    expect(runtime._internals.bootstrapError).toBe(false);
    expect(runtime._internals.coldStart).toBe(false);

    // Restore the original bootstrap mock for downstream tests.
    mock.module('../src/bootstrap', () => ({
      bootstrap: async () => {
        runtimeState.bootstrapCalls += 1;
        return { ctx: runtimeState.ctx, teardown: runtimeState.teardown };
      },
    }));
  });
});
