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

describe('createFunctionsFromManifest', () => {
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

  test('wraps every lambda binding declared in the manifest', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const processOrder = createHandler('processOrder');
    const dailyCleanup = createHandler('dailyCleanup');

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          processOrderApi: {
            handler: 'processOrder',
            trigger: 'apigw-v2',
            idempotency: { ttl: 60 },
          },
          dailyCleanup: {
            handler: 'dailyCleanup',
            trigger: 'schedule',
          },
        },
      },
      registry: {
        resolveHandler(name: string) {
          return name === 'processOrder' ? processOrder : dailyCleanup;
        },
        hasHandler() {
          return true;
        },
      },
    };

    const wrapped = await createFunctionsFromManifest({ manifestVersion: 1 });

    expect(Object.keys(wrapped)).toEqual(['processOrderApi', 'dailyCleanup']);
    expect(typeof wrapped.processOrderApi).toBe('function');
    expect(typeof wrapped.dailyCleanup).toBe('function');
  });

  test('returns an empty export map when no lambdas are declared', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    manifestState.resolved = {
      config: {},
      manifest: {},
      registry: {
        resolveHandler() {
          throw new Error('should not be called');
        },
        hasHandler() {
          return false;
        },
      },
    };

    await expect(createFunctionsFromManifest({ manifestVersion: 1 })).resolves.toEqual({});
  });

  test('throws when a manifest lambda resolves to a non-handler export', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          bad: { handler: 'notAHandler', trigger: 'sqs' },
        },
      },
      registry: {
        resolveHandler() {
          return () => 'plain function';
        },
        hasHandler() {
          return true;
        },
      },
    };

    await expect(createFunctionsFromManifest({ manifestVersion: 1 })).rejects.toThrow(
      "Manifest lambda 'bad' handler 'notAHandler' is not a SlingshotHandler",
    );
  });

  test('throws HandlerResolutionError with explicit message when handlersPath does not exist on disk', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const { HandlerResolutionError } = await import('../src/errors');

    const missing = '/tmp/slingshot-runtime-lambda-tests/__definitely_missing__.ts';

    let caught: unknown;
    try {
      await createFunctionsFromManifest({ manifestVersion: 1 }, { handlersPath: missing });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HandlerResolutionError);
    expect((caught as Error).message).toContain('Handlers file not found at');
    expect((caught as Error).message).toContain(missing);
    expect((caught as InstanceType<typeof HandlerResolutionError>).handlersPath).toBe(missing);
  });

  test('wraps loader errors with the resolved file path and original cause', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const { HandlerResolutionError } = await import('../src/errors');

    // Use an existing file on disk so the file-existence check passes; the
    // mocked resolveManifestConfig is what raises the simulated import error.
    const existingPath = __filename;
    const original = manifestState.resolved;
    const importError = new SyntaxError('Unexpected token in handlers file');

    mock.module('@lastshotlabs/slingshot/manifest', () => ({
      resolveManifestConfig: async () => {
        throw importError;
      },
    }));

    let caught: unknown;
    try {
      await createFunctionsFromManifest({ manifestVersion: 1 }, { handlersPath: existingPath });
    } catch (err) {
      caught = err;
    } finally {
      // Restore the default mock for subsequent tests.
      mock.module('@lastshotlabs/slingshot/manifest', () => ({
        resolveManifestConfig: async () => manifestState.resolved,
      }));
      manifestState.resolved = original;
    }

    expect(caught).toBeInstanceOf(HandlerResolutionError);
    const err = caught as InstanceType<typeof HandlerResolutionError>;
    expect(err.message).toContain('Failed to load handlers');
    expect(err.message).toContain(existingPath);
    expect(err.message).toContain('Unexpected token in handlers file');
    expect(err.cause).toBe(importError);
    expect(err.handlersPath).toBe(existingPath);
  });

  test('lists available exports when a manifest handler reference is missing from the registry', async () => {
    const { createFunctionsFromManifest } = await import('../src/manifest');
    const { HandlerResolutionError } = await import('../src/errors');

    manifestState.resolved = {
      config: {},
      manifest: {
        lambdas: {
          orders: { handler: 'processOrderr', trigger: 'sqs' },
        },
      },
      registry: {
        resolveHandler(name: string) {
          throw new Error(
            `[ManifestHandlerRegistry] Unknown handler "${name}". Registered: [processOrder, dailyCleanup]`,
          );
        },
        hasHandler() {
          return false;
        },
        listHandlers() {
          return ['processOrder', 'dailyCleanup'];
        },
      } as unknown as ResolvedManifestState['registry'],
    };

    let caught: unknown;
    try {
      await createFunctionsFromManifest({ manifestVersion: 1 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HandlerResolutionError);
    const err = caught as InstanceType<typeof HandlerResolutionError>;
    expect(err.exportName).toBe('orders');
    expect(err.handlerRef).toBe('processOrderr');
    expect(err.message).toContain("Manifest lambda 'orders'");
    expect(err.message).toContain("handler 'processOrderr'");
    expect(err.message).toContain('Available exports: [processOrder, dailyCleanup]');
    expect(err.availableExports).toEqual(['processOrder', 'dailyCleanup']);
  });
});
