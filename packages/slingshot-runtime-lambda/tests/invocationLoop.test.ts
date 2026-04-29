import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type {
  SlingshotContext,
  SlingshotHandler,
  TriggerAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  HandlerError,
  ValidationError,
  createDefaultIdentityResolver,
} from '@lastshotlabs/slingshot-core';
import { configureRuntimeLambdaLogger, invokeWithAdapter } from '../src/invocationLoop';
import { apigwTrigger } from '../src/triggers/apigw';
import { kinesisTrigger } from '../src/triggers/kinesis';
import { scheduleTrigger } from '../src/triggers/schedule';
import { sqsTrigger } from '../src/triggers/sqs';

function createContextFixture(overrides: Partial<SlingshotContext> = {}): SlingshotContext {
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
    ...overrides,
  } as unknown as SlingshotContext;
}

function createHandler(impl: (input: unknown) => Promise<unknown>): SlingshotHandler {
  return {
    name: 'test.handler',
    input: z.any(),
    output: z.any(),
    guards: [],
    after: [],
    async invoke(raw) {
      return impl(raw);
    },
  };
}

describe('invokeWithAdapter', () => {
  test('idempotency key conflict is classified as idempotency error kind', async () => {
    let errorKind: string | undefined;
    const handler = createHandler(async () => 'ok');
    const ctx = createContextFixture({
      persistence: {
        idempotency: {
          async get() {
            return {
              response: JSON.stringify({ value: 'cached' }),
              requestFingerprint: 'different-fingerprint',
            };
          },
          async set() {},
        },
        auditLog: {
          async logEntry() {},
          async getLogs() {
            return { items: [] };
          },
        },
      } as unknown as SlingshotContext['persistence'],
    });

    await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [{ messageId: 'msg-1', body: JSON.stringify({ x: 1 }) }],
      },
      ctx,
      {
        async onError({ kind }) {
          errorKind = kind;
          return undefined;
        },
      },
      { idempotency: { fingerprint: true } },
      false,
    );

    expect(errorKind).toBe('idempotency');
  });

  test('returns SQS partial batch failures for record-level errors', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async input => {
      const body = input as { fail?: boolean };
      if (body.fail) {
        throw new HandlerError('boom', { status: 500 });
      }
      return { ok: true };
    });

    const result = await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [
          { messageId: 'ok-1', body: JSON.stringify({ fail: false }) },
          { messageId: 'bad-1', body: JSON.stringify({ fail: true }) },
        ],
      },
      ctx,
      undefined,
      undefined,
      true,
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'bad-1' }],
    });
  });

  test('rethrows failures for whole-batch retry triggers', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new ValidationError([]);
    });

    await expect(
      invokeWithAdapter(
        handler,
        kinesisTrigger as TriggerAdapter,
        {
          Records: [
            {
              eventID: 'evt-1',
              kinesis: {
                sequenceNumber: 'seq-1',
                data: Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64'),
              },
            },
          ],
        },
        ctx,
        undefined,
        undefined,
        false,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('supports beforeInvoke aborts without invoking the handler', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new Error('handler should not run');
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      {
        body: JSON.stringify({ ok: true }),
        headers: {},
        requestContext: { requestId: 'req-1' },
      },
      ctx,
      {
        async beforeInvoke() {
          return { abort: true, response: { aborted: true } };
        },
      },
      undefined,
      true,
    );

    expect(result).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aborted: true }),
      isBase64Encoded: false,
    });
  });

  test('allows onError to suppress single-record failures', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new HandlerError('boom', { status: 500, code: 'boom' });
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      {
        body: JSON.stringify({ ok: true }),
        headers: {},
        requestContext: { requestId: 'req-2' },
      },
      ctx,
      {
        async onError() {
          return {
            suppress: true,
            status: 202,
            body: { accepted: true },
          };
        },
      },
      undefined,
      true,
    );

    expect(result).toEqual({
      statusCode: 202,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true }),
      isBase64Encoded: false,
    });
  });

  test('uses onError replacement errors when building single-record HTTP failures', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new Error('boom');
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      {
        body: JSON.stringify({ ok: true }),
        headers: {},
        requestContext: { requestId: 'req-3' },
      },
      ctx,
      {
        async onError() {
          return {
            replaceWith: new HandlerError('replaced', { status: 409, code: 'conflict' }),
          };
        },
      },
      undefined,
      true,
    );

    expect(result).toEqual({
      statusCode: 409,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'replaced', code: 'conflict' }),
      isBase64Encoded: false,
    });
  });

  test('drops failed batch records when onRecordError returns drop', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async input => {
      const body = input as { fail?: boolean };
      if (body.fail) {
        throw new HandlerError('boom', { status: 500 });
      }
      return { ok: true };
    });

    const result = await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [
          { messageId: 'ok-1', body: JSON.stringify({ fail: false }) },
          { messageId: 'drop-1', body: JSON.stringify({ fail: true }) },
        ],
      },
      ctx,
      {
        async onRecordError() {
          return 'drop' as const;
        },
      },
      undefined,
      false,
    );

    expect(result).toEqual({
      batchItemFailures: [],
    });
  });

  test('auto-enables idempotency for SQS records with natural keys', async () => {
    const get = mock(async () => null);
    const set = mock(async () => {});
    const ctx = createContextFixture({
      persistence: {
        idempotency: { get, set },
        auditLog: {
          async logEntry() {},
          async getLogs() {
            return { items: [] };
          },
        },
      } as unknown as SlingshotContext['persistence'],
    });
    const handler = createHandler(async input => ({ echoed: input }));

    await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [{ messageId: 'msg-1', body: JSON.stringify({ ok: true }) }],
      },
      ctx,
      undefined,
      undefined,
      true,
    );

    expect(get).toHaveBeenCalledWith('functions-idempotency:test.handler:sqs:msg-1');
    expect(set).toHaveBeenCalledTimes(1);
  });

  test('passes afterInvoke the output, error, and latency metadata', async () => {
    const calls: Array<{ output: unknown; error?: Error; trigger: string }> = [];
    const ctx = createContextFixture();
    const handler = createHandler(async input => ({ input }));

    await invokeWithAdapter(
      handler,
      scheduleTrigger as TriggerAdapter,
      { id: 'sched-1', time: '2026-04-19T00:00:00Z', detail: { ok: true } },
      ctx,
      {
        async afterInvoke(args) {
          calls.push({
            output: args.output,
            error: args.error,
            trigger: args.trigger,
          });
          expect(args.latencyMs).toBeGreaterThanOrEqual(0);
        },
      },
      undefined,
      false,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      output: { input: { ok: true } },
      error: undefined,
      trigger: 'schedule',
    });
  });

  test('beforeInvoke hook throwing routes to onError without invoking the handler (P-LAMBDA-2)', async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLambdaLogger({
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

    const ctx = createContextFixture();
    let handlerCalls = 0;
    const handler = createHandler(async () => {
      handlerCalls += 1;
      return { ok: true };
    });

    let result: unknown;
    const onErrorSeen: { kind?: string; message?: string } = {};
    try {
      result = await invokeWithAdapter(
        handler,
        sqsTrigger as TriggerAdapter,
        { Records: [{ messageId: 'msg-1', body: '{}' }] },
        ctx,
        {
          async beforeInvoke() {
            throw new Error('beforeInvoke hook crashed');
          },
          async onError(args) {
            onErrorSeen.kind = args.kind;
            onErrorSeen.message = args.error.message;
            return undefined;
          },
        },
        undefined,
        false,
      );
    } finally {
      configureRuntimeLambdaLogger(previous);
    }

    // Handler MUST NOT run when beforeInvoke throws — the invocation must
    // route through the error path with explicit failure state.
    expect(handlerCalls).toBe(0);
    const batchResult = result as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(batchResult.batchItemFailures).toHaveLength(1);
    expect(batchResult.batchItemFailures[0]?.itemIdentifier).toBe('msg-1');
    // Structured logger received the hook-threw event.
    const ev = events.find(e => e.event === 'hook-threw' && e.fields?.hook === 'beforeInvoke');
    expect(ev).toBeDefined();
    // onError fired with the wrapped HandlerError.
    expect(onErrorSeen.kind).toBe('handler');
    expect(onErrorSeen.message).toContain('beforeInvoke hook failed');
  });

  test('onRecordError hook throw logs structurally and reports records as error (P-LAMBDA-3)', async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLambdaLogger({
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

    const handler = createHandler(async () => {
      throw new Error('record-failed');
    });
    const ctx = createContextFixture();

    let result: unknown;
    try {
      result = await invokeWithAdapter(
        handler,
        sqsTrigger as TriggerAdapter,
        {
          Records: [
            { messageId: 'msg-1', body: '{}' },
            { messageId: 'msg-2', body: '{}' },
          ],
        },
        ctx,
        {
          async onRecordError() {
            throw new Error('hook-boom');
          },
        },
        undefined,
        false,
      );
    } finally {
      configureRuntimeLambdaLogger(previous);
    }

    // Should not throw — the batch result is returned with both records as
    // failed (recordAction defaults to 'retry' which produces result:'error').
    const batchResult = result as { batchItemFailures: unknown[] };
    expect(batchResult.batchItemFailures).toHaveLength(2);
    // Structured event was emitted with the hook name.
    expect(events.some(e => e.event === 'hook-threw' && e.fields?.hook === 'onRecordError')).toBe(
      true,
    );
  });

  test('onError hook throwing does not prevent error handling — invocation returns failure (P-LAMBDA-2)', async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLambdaLogger({
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

    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new Error('handler error');
    });

    let result: unknown;
    try {
      result = await invokeWithAdapter(
        handler,
        sqsTrigger as TriggerAdapter,
        { Records: [{ messageId: 'msg-2', body: '{}' }] },
        ctx,
        {
          async onError() {
            throw new Error('onError hook crashed');
          },
        },
        undefined,
        false,
      );
    } finally {
      configureRuntimeLambdaLogger(previous);
    }

    // Record failed (handler threw) — appears in batchItemFailures.
    // The thrown onError is discarded (no false suppression).
    const batchResult = result as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(batchResult.batchItemFailures).toHaveLength(1);
    expect(batchResult.batchItemFailures[0]?.itemIdentifier).toBe('msg-2');
    expect(events.some(e => e.event === 'hook-threw' && e.fields?.hook === 'onError')).toBe(true);
  });

  // P-LAMBDA-2 — afterInvoke hook throw is observability-only.
  test('afterInvoke hook throwing does not corrupt the record outcome (P-LAMBDA-2)', async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const previous = configureRuntimeLambdaLogger({
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

    const ctx = createContextFixture();
    const handler = createHandler(async () => ({ ok: true }));

    try {
      const result = (await invokeWithAdapter(
        handler,
        sqsTrigger as TriggerAdapter,
        { Records: [{ messageId: 'msg-9', body: '{}' }] },
        ctx,
        {
          async afterInvoke() {
            throw new Error('afterInvoke hook crashed');
          },
        },
        undefined,
        false,
      )) as { batchItemFailures: unknown[] };
      // Handler succeeded — afterInvoke throw must not invent a failure.
      expect(result.batchItemFailures).toHaveLength(0);
    } finally {
      configureRuntimeLambdaLogger(previous);
    }
    expect(events.some(e => e.event === 'hook-threw' && e.fields?.hook === 'afterInvoke')).toBe(
      true,
    );
  });
});
