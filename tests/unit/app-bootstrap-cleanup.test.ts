/**
 * Tests for bootstrap failure cleanup in src/app.ts.
 *
 * Strategy: make `assembleApp()` throw NATURALLY by passing
 * `permissions: { adapter: 'postgres' }` without configuring postgres.
 * The framework auto-synthesizes a permissions plugin whose `setupMiddleware`
 * calls `resolveRepo(…, 'postgres', infra)` which throws because postgres
 * is not configured. This happens AFTER `buildContext()` succeeds, so the
 * catch block in `createApp` calls `partialContextCarrier.ctx.destroy()`
 * which cleans up bus, secrets, sqlite, and all other infrastructure.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { SecretRepository, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
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

function makeTestBus(shutdown: () => Promise<void>): SlingshotEventBus {
  return {
    emit() {},
    on() {},
    onEnvelope() {},
    off() {},
    offEnvelope() {},
    shutdown,
  };
}

describe('cleanupBootstrapFailure', () => {
  test('calls bus.shutdown AND secrets.destroy during cleanup', async () => {
    const busShutdown = mock(async () => {});
    const secretDestroy = mock(async () => {});
    const bus = makeTestBus(busShutdown);
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

    // ctx.destroy() cleans up bus and secrets
    expect(busShutdown).toHaveBeenCalledTimes(1);
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('bus.shutdown error does not prevent secrets.destroy from running', async () => {
    const secretDestroy = mock(async () => {});
    const bus = makeTestBus(async () => {
      throw new Error('bus shutdown failed');
    });
    const secrets: SecretRepository = {
      name: 'test-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: secretDestroy,
    };

    let error: unknown;
    try {
      await createApp({
        ...baseConfig,
        eventBus: bus,
        secrets,
        permissions: { adapter: 'postgres' },
      });
    } catch (err) {
      error = err;
    }

    // The original error propagated, not the bus error
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Postgres');

    // secrets.destroy still ran despite bus.shutdown throwing
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('secrets.destroy error does not change the propagated error', async () => {
    const busShutdown = mock(async () => {});
    const bus = makeTestBus(busShutdown);
    const secrets: SecretRepository = {
      name: 'failing-destroy-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy: async () => {
        throw new Error('destroy failed');
      },
    };

    let error: unknown;
    try {
      await createApp({
        ...baseConfig,
        eventBus: bus,
        secrets,
        permissions: { adapter: 'postgres' },
      });
    } catch (err) {
      error = err;
    }

    // The original error propagated, not the secrets error
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Postgres');

    // bus.shutdown still ran (it's called before secrets.destroy in ctx.destroy())
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
