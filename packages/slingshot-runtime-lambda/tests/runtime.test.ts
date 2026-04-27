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
});
