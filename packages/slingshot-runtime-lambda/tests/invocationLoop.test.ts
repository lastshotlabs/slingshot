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
import { invokeWithAdapter } from '../src/invocationLoop';
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

  test('beforeInvoke hook throwing does not crash the invocation — handler still runs', async () => {
    const errorSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = errorSpy;

    const ctx = createContextFixture();
    const handler = createHandler(async () => ({ ok: true }));

    let result: unknown;
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
        },
        undefined,
        false,
      );
    } finally {
      console.error = originalConsoleError;
    }

    // Handler still ran — no batch failures since the handler itself succeeded
    const batchResult = result as { batchItemFailures: unknown[] };
    expect(batchResult.batchItemFailures).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(String((errorSpy.mock.calls[0] as string[])[0])).toContain('beforeInvoke hook threw');
  });

  test('onError hook throwing does not prevent error handling — invocation returns failure', async () => {
    const errorSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = errorSpy;

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
      console.error = originalConsoleError;
    }

    // Record failed (handler threw) — appears in batchItemFailures
    const batchResult = result as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(batchResult.batchItemFailures).toHaveLength(1);
    expect(batchResult.batchItemFailures[0].itemIdentifier).toBe('msg-2');
    expect(String((errorSpy.mock.calls[0] as string[])[0])).toContain('onError hook threw');
  });
});
