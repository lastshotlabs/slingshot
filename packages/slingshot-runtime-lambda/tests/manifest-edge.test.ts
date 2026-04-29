/**
 * Edge-case tests for manifest-driven lambda function creation: handler mapping,
 * export validation, and HandlerResolutionError details.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { SlingshotHandler } from '@lastshotlabs/slingshot-core';

type ResolvedManifestState = {
  config: Record<string, unknown>;
  manifest: {
    lambdas?: Record<
      string,
      { handler: string; trigger: string; idempotency?: boolean | { ttl?: number } }
    >;
  };
  registry: {
    resolveHandler(name: string): unknown;
    hasHandler(): boolean;
    listHandlers?(): string[];
  };
};

const manifestState: { resolved: ResolvedManifestState } = {
  resolved: {
    config: {},
    manifest: {},
    registry: {
      resolveHandler() {
        return undefined as unknown;
      },
      hasHandler() {
        return false;
      },
    },
  },
};

mock.module('@lastshotlabs/slingshot/manifest', () => ({
  resolveManifestConfig: async () => manifestState.resolved,
}));

function createHandler(name: string): SlingshotHandler {
  return {
    name,
    input: z.any(),
    output: z.any(),
    guards: [],
    after: [],
    async invoke() {
      return { ok: true };
    },
  };
}

describe('createFunctionsFromManifest edge cases', () => {
  beforeEach(() => {
    manifestState.resolved = {
      config: {},
      manifest: {},
      registry: {
        resolveHandler() {
          return undefined as unknown;
        },
        hasHandler() {
          return false;
        },
      },
    };
  });

  test('creates single handler function from manifest', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const processOrder = createHandler('processOrder');

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          processOrderApi: {
            handler: 'processOrder',
            trigger: 'apigw-v2',
          },
        },
      },
      registry: {
        resolveHandler() {
          return processOrder;
        },
        hasHandler() {
          return true;
        },
      },
    };

    const wrapped = await createFunctionsFromManifest({ manifestVersion: 1 });
    expect(Object.keys(wrapped)).toEqual(['processOrderApi']);
    expect(typeof wrapped.processOrderApi).toBe('function');
  });

  test('creates multiple handler functions from manifest', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const orderHandler = createHandler('processOrder');
    const auditHandler = createHandler('auditLog');
    const notifyHandler = createHandler('sendNotification');

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          orderApi: { handler: 'processOrder', trigger: 'apigw-v2' },
          auditScheduler: { handler: 'auditLog', trigger: 'schedule' },
          notificationWorker: { handler: 'sendNotification', trigger: 'sqs' },
        },
      },
      registry: {
        resolveHandler(name: string) {
          const map: Record<string, SlingshotHandler> = {
            processOrder: orderHandler,
            auditLog: auditHandler,
            sendNotification: notifyHandler,
          };
          return map[name];
        },
        hasHandler() {
          return true;
        },
      },
    };

    const wrapped = await createFunctionsFromManifest({ manifestVersion: 1 });
    expect(Object.keys(wrapped)).toHaveLength(3);
    expect(typeof wrapped.orderApi).toBe('function');
    expect(typeof wrapped.auditScheduler).toBe('function');
    expect(typeof wrapped.notificationWorker).toBe('function');
  });

  test('throws when handler reference is missing from registry', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const { HandlerResolutionError } = await import('../src/errors');

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          orders: { handler: 'nonExistent', trigger: 'sqs' },
        },
      },
      registry: {
        resolveHandler() {
          throw new Error('not found');
        },
        hasHandler() {
          return false;
        },
      },
    };

    await expect(createFunctionsFromManifest({ manifestVersion: 1 })).rejects.toThrow(
      HandlerResolutionError,
    );
  });

  test('returns empty map when manifest has no lambdas', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const result = await createFunctionsFromManifest({ manifestVersion: 1 });
    expect(result).toEqual({});
  });

  test('throws when handlersPath does not exist on disk', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const { HandlerResolutionError } = await import('../src/errors');

    const missing = '/tmp/__slingshot_test_missing_handlers__.ts';

    let caught: unknown;
    try {
      await createFunctionsFromManifest({ manifestVersion: 1 }, { handlersPath: missing });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HandlerResolutionError);
    expect((caught as Error).message).toContain(missing);
  });

  test('caches handler resolution across calls', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const processOrder = createHandler('processOrder');
    let resolveCount = 0;

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          api: { handler: 'processOrder', trigger: 'schedule' },
        },
      },
      registry: {
        resolveHandler() {
          resolveCount++;
          return processOrder;
        },
        hasHandler() {
          return true;
        },
      },
    };

    await createFunctionsFromManifest({ manifestVersion: 1 });
    expect(resolveCount).toBe(1);
  });
});
