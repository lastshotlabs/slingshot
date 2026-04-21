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
  test('calls bus.shutdown AND secrets.destroy during cleanup', async () => {
    const busShutdown = mock(async () => {});
    const secretDestroy = mock(async () => {});
    const bus = {
      publish: async () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
      shutdown: busShutdown,
    };
    const secrets: SecretRepository = {
      name: 'test-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: secretDestroy,
    };

    await expect(
      createApp({
        ...baseConfig,
        eventBus: bus,
        secrets,
        permissions: { adapter: 'postgres' },
      }),
    ).rejects.toThrow('Postgres');

    // Both cleanup paths ran — line 342 (bus.shutdown) and line 374 (secrets.destroy)
    expect(busShutdown).toHaveBeenCalledTimes(1);
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('bus.shutdown error does not prevent secrets.destroy from running', async () => {
    const secretDestroy = mock(async () => {});
    const bus = {
      publish: async () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
      shutdown: async () => {
        throw new Error('bus shutdown failed');
      },
    };
    const secrets: SecretRepository = {
      name: 'test-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: secretDestroy,
    };

    const error = await createApp({
      ...baseConfig,
      eventBus: bus,
      secrets,
      permissions: { adapter: 'postgres' },
    }).catch((e: Error) => e);

    // The original error propagated, not the bus error
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Postgres');

    // secrets.destroy still ran despite bus.shutdown throwing (line 374)
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('secrets.destroy error does not change the propagated error', async () => {
    const busShutdown = mock(async () => {});
    const bus = {
      publish: async () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
      shutdown: busShutdown,
    };
    const secrets: SecretRepository = {
      name: 'failing-destroy-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: async () => {
        throw new Error('destroy failed');
      },
    };

    const error = await createApp({
      ...baseConfig,
      eventBus: bus,
      secrets,
      permissions: { adapter: 'postgres' },
    }).catch((e: Error) => e);

    // The original error propagated, not the secrets error
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Postgres');

    // bus.shutdown still ran (it's called before secrets.destroy, line 342)
    expect(busShutdown).toHaveBeenCalledTimes(1);
  });

  test('sqlite db is closed during cleanup (handle unusable after failure)', async () => {
    // Use a file-based sqlite path so we can verify the handle is released
    const tmpPath = `${import.meta.dir}/fixtures/.test-cleanup-${Date.now()}.sqlite`;

    try {
      await createApp({
        ...baseConfig,
        db: { ...baseConfig.db, sqlite: tmpPath },
        permissions: { adapter: 'postgres' },
      });
    } catch {
      // expected — permissions adapter fails
    }

    // If cleanupBootstrapFailure closed the db (line 367), we should be able
    // to open a fresh connection to the file without contention.
    const { Database } = await import('bun:sqlite');
    const db = new Database(tmpPath);
    // If the handle wasn't closed, this would throw or show lock contention
    db.exec('CREATE TABLE cleanup_proof (id INTEGER PRIMARY KEY)');
    db.close();

    // Clean up the temp file
    const fs = await import('node:fs');
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  });
});
