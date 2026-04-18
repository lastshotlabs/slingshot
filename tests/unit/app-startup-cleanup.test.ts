import { describe, expect, mock, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SecretRepository, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Startup Cleanup Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

describe('createApp startup cleanup', () => {
  test('destroys the partial app context when plugin setup fails after bootstrap', async () => {
    const bus = createInProcessAdapter();
    const busShutdown = mock(async () => {});
    bus.shutdown = busShutdown;

    const secretDestroy = mock(async () => {});
    const secrets: SecretRepository = {
      name: 'test-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: secretDestroy,
    };

    const teardown = mock(async () => {});
    const plugins: SlingshotPlugin[] = [
      {
        name: 'teardown-plugin',
        setupMiddleware: async () => {},
        teardown,
      },
      {
        name: 'failing-plugin',
        setupRoutes: async () => {
          throw new Error('setupRoutes failed');
        },
      },
    ];

    await expect(
      createApp({
        ...baseConfig,
        eventBus: bus,
        secrets,
        plugins,
      }),
    ).rejects.toThrow('setupRoutes failed');

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(busShutdown).toHaveBeenCalledTimes(1);
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });
});
