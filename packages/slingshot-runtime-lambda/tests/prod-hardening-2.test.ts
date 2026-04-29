/**
 * Prod-hardening tests for Lambda runtime: handler timeout, concurrent invocation
 * isolation, and inflight tracking correctness.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotContext, SlingshotHandler } from '@lastshotlabs/slingshot-core';
import { createDefaultIdentityResolver, HandlerError } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Bootstrap mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    bus: { emit() {}, on() {}, off() {} },
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
    name: 'prod-hardening-2',
    input: z.any(),
    output: z.any(),
    guards: [],
    after: [],
    async invoke(raw: unknown, opts: { meta?: Record<string, unknown> }) {
      return impl(raw, opts.meta ?? {});
    },
  };
}

/** Minimal apigw-v2 event for tests that need observable HTTP responses. */
function apigwEvent(body: unknown, requestId = 'req') {
  return {
    body: JSON.stringify(body),
    headers: {},
    requestContext: { requestId, http: { method: 'POST', path: '/test' } },
  };
}

function parseBody(resp: Record<string, unknown>): unknown {
  return JSON.parse(resp.body as string);
}

// ---------------------------------------------------------------------------
// Handler timeout
// ---------------------------------------------------------------------------

describe('Lambda runtime — handler timeout', () => {
  beforeEach(() => {
    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();
    runtimeState.teardown = mock(async () => {});
  });

  test('handlerTimeoutMs returns 504 with handler-timeout code for slow handlers', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      handlerTimeoutMs: 20,
    });

    const handler = createHandler(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { ok: true };
    });

    // Use apigw-v2 so the timeout error surfaces as a structured 504 response
    const wrapped = runtime.wrap(handler, 'apigw-v2');
    const resp = await wrapped(apigwEvent({}), 'timeout-req');
    expect((resp as Record<string, unknown>).statusCode).toBe(504);
    const body = parseBody(resp as Record<string, unknown>);
    expect(body).toMatchObject({ code: 'handler-timeout' });
  });

  test('handlerTimeoutMs allows fast handlers to return 200', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      handlerTimeoutMs: 5_000,
    });

    const handler = createHandler(async () => ({ ok: true, value: 42 }));
    const wrapped = runtime.wrap(handler, 'apigw-v2');
    const resp = await wrapped(apigwEvent({}), 'fast-req');
    expect((resp as Record<string, unknown>).statusCode).toBe(200);
    expect(parseBody(resp as Record<string, unknown>)).toEqual({ ok: true, value: 42 });
  });

  test('zero handlerTimeoutMs disables the timeout', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      handlerTimeoutMs: 0,
    });

    let resolved = false;
    const handler = createHandler(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      resolved = true;
      return { ok: true };
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');
    const resp = await wrapped(apigwEvent({}), 'no-timeout');
    expect((resp as Record<string, unknown>).statusCode).toBe(200);
    expect(resolved).toBe(true);
  });

  test('undefined handlerTimeoutMs imposes no timeout', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    let resolved = false;
    const handler = createHandler(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      resolved = true;
      return { ok: true };
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');
    await wrapped(apigwEvent({}), 'no-timeout');
    expect(resolved).toBe(true);
  });

  test('negative handlerTimeoutMs disables the timeout', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      handlerTimeoutMs: -1,
    });

    let resolved = false;
    const handler = createHandler(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      resolved = true;
      return { ok: true };
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');
    await wrapped(apigwEvent({}), 'neg-timeout');
    expect(resolved).toBe(true);
  });

  test('timeout applies per-invocation — warm invocations also time out', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      handlerTimeoutMs: 20,
    });

    const handler = createHandler(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { ok: true };
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');

    // Cold invocation — times out
    const coldResp = await wrapped(apigwEvent({}), 'cold');
    expect((coldResp as Record<string, unknown>).statusCode).toBe(504);

    // Warm invocation — must also time out (timeout is not cached)
    const warmResp = await wrapped(apigwEvent({}), 'warm');
    expect((warmResp as Record<string, unknown>).statusCode).toBe(504);
    expect(parseBody(warmResp as Record<string, unknown>)).toMatchObject({ code: 'handler-timeout' });
  });
});

// ---------------------------------------------------------------------------
// Concurrent invocation isolation
// ---------------------------------------------------------------------------

describe('Lambda runtime — concurrent invocation isolation', () => {
  beforeEach(() => {
    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();
    runtimeState.teardown = mock(async () => {});
  });

  test('concurrent invocations both complete with correct results', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    const handler = createHandler(async input => {
      const val = (input as { id?: number }).id ?? 0;
      return { echoed: val };
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');
    const [r1, r2] = await Promise.all([
      wrapped(apigwEvent({ id: 1 }, 'c1')),
      wrapped(apigwEvent({ id: 2 }, 'c2')),
    ]);

    expect((r1 as Record<string, unknown>).statusCode).toBe(200);
    expect(parseBody(r1 as Record<string, unknown>)).toEqual({ echoed: 1 });
    expect((r2 as Record<string, unknown>).statusCode).toBe(200);
    expect(parseBody(r2 as Record<string, unknown>)).toEqual({ echoed: 2 });
  });

  test('error in one concurrent invocation does not affect the other', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');
    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    const failHandler = createHandler(async () => {
      throw new Error('handler-fail');
    });
    const okHandler = createHandler(async () => ({ ok: true }));

    const failWrapped = runtime.wrap(failHandler, 'apigw-v2');
    const okWrapped = runtime.wrap(okHandler, 'apigw-v2');

    const results = await Promise.allSettled([
      failWrapped(apigwEvent({}, 'r1')),
      okWrapped(apigwEvent({}, 'r2')),
    ]);

    // Both apigw-v2 invocations resolve (errors encoded as 500 responses)
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);

    const values = results.map(
      r => (r as PromiseFulfilledResult<Record<string, unknown>>).value,
    );
    const statusCodes = values.map(v => v.statusCode);
    expect(statusCodes).toContain(200);
    expect(statusCodes).toContain(500);

    const successResponse = values.find(v => v.statusCode === 200);
    expect(parseBody(successResponse!)).toEqual({ ok: true });
  });

  test('inflightCount accurately reflects active invocations', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    let startHandler1!: () => void;
    const handler1Started = new Promise<void>(resolve => {
      startHandler1 = resolve;
    });
    let releaseHandler1!: () => void;
    const release1 = new Promise<void>(resolve => {
      releaseHandler1 = resolve;
    });

    let startHandler2!: () => void;
    const handler2Started = new Promise<void>(resolve => {
      startHandler2 = resolve;
    });
    let releaseHandler2!: () => void;
    const release2 = new Promise<void>(resolve => {
      releaseHandler2 = resolve;
    });

    const handler1 = createHandler(async () => {
      startHandler1();
      await release1;
      return { ok: true, id: 1 };
    });
    const handler2 = createHandler(async () => {
      startHandler2();
      await release2;
      return { ok: true, id: 2 };
    });

    const wrapped1 = runtime.wrap(handler1, 'schedule');
    const wrapped2 = runtime.wrap(handler2, 'schedule');

    const inv1 = wrapped1({ id: 'h1', time: '2026-01-01T00:00:00Z', detail: {} }, {});
    const inv2 = wrapped2({ id: 'h2', time: '2026-01-01T00:00:00Z', detail: {} }, {});

    await Promise.all([handler1Started, handler2Started]);

    expect(
      (runtime as unknown as { _internals: { inflightCount: number } })._internals.inflightCount,
    ).toBe(2);

    releaseHandler1();
    releaseHandler2();
    await Promise.all([inv1, inv2]);

    expect(
      (runtime as unknown as { _internals: { inflightCount: number } })._internals.inflightCount,
    ).toBe(0);
  });

  test('concurrent failing invocations do not leak inflight state', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    const handler = createHandler(async () => {
      throw new Error('handler-fail');
    });

    const wrapped = runtime.wrap(handler, 'apigw-v2');

    const results = await Promise.allSettled([
      wrapped(apigwEvent({}, 'r1')),
      wrapped(apigwEvent({}, 'r2')),
    ]);

    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect(
      (runtime as unknown as { _internals: { inflightCount: number } })._internals.inflightCount,
    ).toBe(0);

    // A subsequent invocation with a clean handler should work
    const okHandler = createHandler(async () => ({ recovered: true }));
    const okWrapped = runtime.wrap(okHandler, 'apigw-v2');
    const resp = await okWrapped(apigwEvent({}, 'recovery'));
    expect((resp as Record<string, unknown>).statusCode).toBe(200);
    expect(parseBody(resp as Record<string, unknown>)).toEqual({ recovered: true });
  });

  test('concurrent invocations reuse cached context after initial bootstrap', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    runtimeState.bootstrapCalls = 0;
    runtimeState.ctx = createContextFixture();

    const runtime = createLambdaRuntime({ manifest: { manifestVersion: 1 } });

    const handler = createHandler(async () => ({ ok: true }));
    const wrapped = runtime.wrap(handler, 'schedule');

    // First batch — on a truly concurrent cold start the race at `if (!cached)`
    // may cause multiple bootstrap() calls from concurrent invocations before
    // the first one has set cached. This is expected behaviour.
    await Promise.all([
      wrapped({ id: 'a', time: '2026-01-01T00:00:00Z', detail: {} }, { awsRequestId: 'a' }),
      wrapped({ id: 'b', time: '2026-01-01T00:00:00Z', detail: {} }, { awsRequestId: 'b' }),
    ]);

    const afterFirstBatch = runtimeState.bootstrapCalls;
    expect(afterFirstBatch).toBeGreaterThanOrEqual(1);

    // Second batch — must NOT trigger any additional bootstrap calls because
    // cached is now set by the first batch.
    await Promise.all([
      wrapped({ id: 'c', time: '2026-01-01T00:00:00Z', detail: {} }, { awsRequestId: 'c' }),
      wrapped({ id: 'd', time: '2026-01-01T00:00:00Z', detail: {} }, { awsRequestId: 'd' }),
    ]);

    expect(runtimeState.bootstrapCalls).toBe(afterFirstBatch);
  });

  test('coldStart transitions correctly after concurrent invocations complete', async () => {
    const { createLambdaRuntime } = await import('../src/runtime');

    const coldStartLog: boolean[] = [];
    const runtime = createLambdaRuntime({
      manifest: { manifestVersion: 1 },
      hooks: {
        beforeInvoke(args) {
          coldStartLog.push(args.isColdStart);
          return undefined;
        },
      },
    });

    const handler = createHandler(async () => ({ ok: true }));
    const wrapped = runtime.wrap(handler, 'schedule');

    // Fire two concurrent invocations
    await Promise.all([
      wrapped({ id: 'c1', time: '2026-01-01T00:00:00Z', detail: {} }, {}),
      wrapped({ id: 'c2', time: '2026-01-01T00:00:00Z', detail: {} }, {}),
    ]);

    // After all concurrent invocations settle, a third sequential call
    // must observe coldStart=false.
    await wrapped({ id: 'c3', time: '2026-01-01T00:00:00Z', detail: {} }, {});

    expect(coldStartLog).toHaveLength(3);

    // At least one of the concurrent calls observed coldStart=true.
    // On a truly concurrent cold start both may see true because neither
    // has reached the finally block that flips the flag before the other
    // reads it.
    const trueCount = coldStartLog.filter(v => v === true).length;
    expect(trueCount).toBeGreaterThanOrEqual(1);

    // The third sequential call must be warm.
    expect(coldStartLog[2]).toBe(false);
  });
});
