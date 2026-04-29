/**
 * Edge-case tests for the Lambda invocation loop: batch failure handling,
 * partial batch success, retry with delay, and idempotency with batch records.
 */
import { describe, expect, mock, spyOn, test } from 'bun:test';
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
import { sqsTrigger } from '../src/triggers/sqs';

type BatchResult = { batchItemFailures: Array<{ itemIdentifier: string }> };

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

describe('invocation loop — batch handling', () => {
  test('partial batch success returns only failed items', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async input => {
      const body = input as { fail?: boolean };
      if (body.fail) {
        throw new HandlerError('item failed', { status: 500 });
      }
      return { ok: true };
    });

    const result = (await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [
          { messageId: 'ok-1', body: JSON.stringify({ fail: false }) },
          { messageId: 'bad-1', body: JSON.stringify({ fail: true }) },
          { messageId: 'ok-2', body: JSON.stringify({ fail: false }) },
          { messageId: 'bad-2', body: JSON.stringify({ fail: true }) },
        ],
      },
      ctx,
      undefined,
      undefined,
      true,
    )) as BatchResult;

    expect(result.batchItemFailures).toHaveLength(2);
    const failedIds = result.batchItemFailures.map(f => f.itemIdentifier);
    expect(failedIds).toContain('bad-1');
    expect(failedIds).toContain('bad-2');
  });

  test('all batch records succeeding returns empty failures array', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => ({ ok: true }));

    const result = (await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [
          { messageId: 'a', body: JSON.stringify({ id: 1 }) },
          { messageId: 'b', body: JSON.stringify({ id: 2 }) },
          { messageId: 'c', body: JSON.stringify({ id: 3 }) },
        ],
      },
      ctx,
      undefined,
      undefined,
      true,
    )) as BatchResult;

    expect(result.batchItemFailures).toHaveLength(0);
  });

  test('whole-batch retry trigger rethrows on first failure', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async input => {
      const body = input as { fail?: boolean };
      if (body.fail) throw new HandlerError('fatal', { status: 500 });
      return { ok: true };
    });

    const kinesisEvent = {
      Records: [
        {
          eventID: 'evt-ok',
          kinesis: {
            sequenceNumber: 'seq-ok',
            data: Buffer.from(JSON.stringify({ fail: false })).toString('base64'),
            partitionKey: 'pk',
          },
        },
        {
          eventID: 'evt-bad',
          kinesis: {
            sequenceNumber: 'seq-bad',
            data: Buffer.from(JSON.stringify({ fail: true })).toString('base64'),
            partitionKey: 'pk',
          },
        },
      ],
    };

    // The first record should succeed, but the second should cause rethrow
    // because kinesis is a whole-batch trigger (batchItemFailures = false)
    await expect(
      invokeWithAdapter(
        handler,
        kinesisTrigger as TriggerAdapter,
        kinesisEvent,
        ctx,
        undefined,
        undefined,
        false,
      ),
    ).rejects.toBeInstanceOf(HandlerError);
  });

  test('onRecordError returning "drop" excludes item from batch failures', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async input => {
      const body = input as { fail?: boolean };
      if (body.fail) throw new HandlerError('boom', { status: 500 });
      return { ok: true };
    });

    const result = (await invokeWithAdapter(
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
      true,
    )) as BatchResult;

    expect(result.batchItemFailures).toHaveLength(0);
  });
});

describe('invocation loop — idempotency with batch records', () => {
  test('idempotent records are replayed from cache', async () => {
    const cachedResponse = JSON.stringify({ cached: true, value: 42 });
    const get = mock(async () => ({
      response: cachedResponse,
      // No requestFingerprint — omitting it means "fingerprint was not stored
      // / not required", so the replay path treats this as a clean cache hit
      // without triggering conflict resolution.
    }));
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

    const handler = createHandler(async () => {
      throw new Error('should not be called');
    });

    const result = (await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [{ messageId: 'cached-1', body: JSON.stringify({ ok: true }) }],
      },
      ctx,
      undefined,
      undefined,
      true,
    )) as BatchResult;

    // Handler should not have run — cache hit
    expect(result.batchItemFailures).toHaveLength(0);
    expect(get).toHaveBeenCalled();
  });

  test('idempotency records are properly stored after successful invocation', async () => {
    const stored: Array<{ key: string; response: string }> = [];
    const get = mock(async () => null);
    const set = mock(async (key: string, response: string) => {
      stored.push({ key, response });
    });
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

    const handler = createHandler(async () => ({ processed: true }));

    const result = (await invokeWithAdapter(
      handler,
      sqsTrigger as TriggerAdapter,
      {
        Records: [{ messageId: 'store-test', body: JSON.stringify({ ok: true }) }],
      },
      ctx,
      undefined,
      undefined,
      true,
    )) as BatchResult;

    expect(result.batchItemFailures).toHaveLength(0);
    expect(set).toHaveBeenCalled();
  });
});

describe('invocation loop — error hooks edge cases', () => {
  test('beforeInvoke returning abort prevents handler execution', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new Error('should not run');
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      { body: JSON.stringify({}), headers: {}, requestContext: { requestId: 'req-1' } },
      ctx,
      {
        async beforeInvoke() {
          return { abort: true, response: { custom: 'response' } };
        },
      },
      undefined,
      true,
    );

    expect(result).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom: 'response' }),
      isBase64Encoded: false,
    });
  });

  test('onError returning suppress changes the HTTP response', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new HandlerError('boom', { status: 500, code: 'ERR' });
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      { body: JSON.stringify({}), headers: {}, requestContext: { requestId: 'req-2' } },
      ctx,
      {
        async onError() {
          return { suppress: true, status: 202, body: { queued: true } };
        },
      },
      undefined,
      true,
    );

    expect(result).toEqual({
      statusCode: 202,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queued: true }),
      isBase64Encoded: false,
    });
  });

  test('onError returning replaceWith changes the error classification', async () => {
    const ctx = createContextFixture();
    const handler = createHandler(async () => {
      throw new Error('raw error');
    });

    const result = await invokeWithAdapter(
      handler,
      apigwTrigger as TriggerAdapter,
      { body: JSON.stringify({}), headers: {}, requestContext: { requestId: 'req-3' } },
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
});
