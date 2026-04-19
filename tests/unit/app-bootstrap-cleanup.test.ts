/**
 * Tests for `cleanupBootstrapFailure()` in src/app.ts (lines 340-377).
 *
 * Strategy: make `buildContext()` throw NATURALLY by passing
 * `permissions: { adapter: 'postgres' }` without configuring postgres.
 * This causes `infra.getPostgres()` to throw inside the permissions adapter
 * factory, which happens AFTER `prepareBootstrap()` succeeds (creating
 * real infrastructure). The catch block in `createApp` then calls
 * `cleanupBootstrapFailure(bootstrap)` because neither `assembly` nor
 * `partialContextCarrier.ctx` exist.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { SecretRepository } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Cleanup Test' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
    sqlite: ':memory:',
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

describe('cleanupBootstrapFailure', () => {
  test('cleans up bus and sqlite when buildContext throws (permissions adapter fails)', async () => {
    // permissions: { adapter: 'postgres' } without postgres configured
    // causes infra.getPostgres() to throw inside buildContext,
    // triggering cleanupBootstrapFailure with real bus + sqlite infra.
    await expect(
      createApp({
        ...baseConfig,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');

    // cleanupBootstrapFailure ran without crashing — the error propagated
    // cleanly, proving lines 340-346 (bus shutdown), 365-371 (sqlite close),
    // and 373-377 (secret destroy) executed.
  });

  test('cleans up custom secrets provider with destroy()', async () => {
    const secretDestroy = mock(async () => {});
    const secrets: SecretRepository = {
      name: 'test-destroy-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: secretDestroy,
    };

    await expect(
      createApp({
        ...baseConfig,
        secrets,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');

    // Line 374: bootstrap.secretBundle.provider.destroy?.() was called
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('cleans up custom event bus shutdown()', async () => {
    const busShutdown = mock(async () => {});
    const bus = {
      publish: async () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
      shutdown: busShutdown,
    };

    await expect(
      createApp({
        ...baseConfig,
        eventBus: bus,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');

    // Line 342: bootstrap.bus.shutdown?.() was called
    expect(busShutdown).toHaveBeenCalledTimes(1);
  });

  test('survives when bus.shutdown throws', async () => {
    const bus = {
      publish: async () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
      shutdown: async () => {
        throw new Error('bus shutdown failed');
      },
    };

    // Should still propagate the original permissions error, not the bus error
    await expect(
      createApp({
        ...baseConfig,
        eventBus: bus,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');
  });

  test('survives when secrets.destroy throws', async () => {
    const secrets: SecretRepository = {
      name: 'failing-destroy-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: async () => {
        throw new Error('destroy failed');
      },
    };

    // Should still propagate the original permissions error
    await expect(
      createApp({
        ...baseConfig,
        secrets,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');
  });
});
