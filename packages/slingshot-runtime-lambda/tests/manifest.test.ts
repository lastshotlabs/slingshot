import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SlingshotHandler } from '@lastshotlabs/slingshot-core';
import { z } from 'zod';

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
});
