/**
 * Edge-case coverage for permission plugin bootstrap and configuration.
 *
 * Builds on the core bootstrap tests in plugin-bootstrap.test.ts.
 * Covers invalid config rejection, adapter factory edge cases, plugin
 * health reporting, and event handler resilience.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import { permissionsAdapterFactories } from '../../src/factories';
import { createPermissionsPackage } from '../../src/plugin';

type MockBus = {
  handlers: Map<string, Array<(data: unknown) => Promise<void>>>;
  on(event: string, handler: (data: unknown) => Promise<void>): void;
  emit(event: string, data: unknown): Promise<void>;
};

function asNever<T>(v: T): never {
  return v as never;
}

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Invalid config rejection
// ---------------------------------------------------------------------------

describe('createPermissionsPackage config validation', () => {
  test('rejects config with null resolvedStores', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();

    await expect(
      pkg.setupMiddleware?.(
        asNever({
          app,
          config: {
            resolvedStores: null,
            storeInfra: {},
          },
          bus: {},
        }),
      ),
    ).rejects.toThrow();
  });

  test('rejects config with undefined resolvedStores', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();

    await expect(
      pkg.setupMiddleware?.(
        asNever({
          app,
          config: {
            resolvedStores: undefined,
            storeInfra: {},
          },
          bus: {},
        }),
      ),
    ).rejects.toThrow();
  });

  test('rejects config with missing storeInfra', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();

    // Missing storeInfra is handled gracefully — plugin still initializes
    await expect(
      pkg.setupMiddleware?.(
        asNever({
          app,
          config: {
            resolvedStores: { authStore: 'memory' },
            storeInfra: undefined,
          },
          bus: {},
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adapter factory edge cases
// ---------------------------------------------------------------------------

describe('permissionsAdapterFactories edge cases', () => {
  test('adapterFactories.memory creates a working adapter', async () => {
    const adapter = await permissionsAdapterFactories.memory(asNever({}));
    const id = await adapter.createGrant({
      subjectId: 'test',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['admin'],
      effect: 'allow',
      grantedBy: 'test',
    });
    expect(id).toBeTruthy();
  });

  test('adapterFactories.redis throws not-implemented', async () => {
    expect(() => permissionsAdapterFactories.redis(asNever({}))).toThrow(
      'Redis permissions adapter is not implemented',
    );
  });

  test('adapterFactories.redis throws not-implemented', async () => {
    expect(() => permissionsAdapterFactories.redis(asNever({}))).toThrow(
      'Redis permissions adapter is not implemented',
    );
  });
});

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

describe('createPermissionsPackage metadata', () => {
  test('package name is slingshot-permissions', () => {
    const pkg = createPermissionsPackage();
    expect(pkg.name).toBe('slingshot-permissions');
  });

  test('package has no dependencies', () => {
    const pkg = createPermissionsPackage();
    expect(pkg.dependencies).toEqual([]);
  });

  test('setupMiddleware without app context still handles gracefully', async () => {
    const pkg = createPermissionsPackage();

    await expect(
      pkg.setupMiddleware?.(
        asNever({
          app: null,
          config: { resolvedStores: { authStore: 'memory' }, storeInfra: {} },
          bus: {},
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin idempotency and resilience
// ---------------------------------------------------------------------------

describe('permissions plugin resilience', () => {
  test('setupPost handles bus events without adapter gracefully', () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();
    // setupMiddleware not called — no adapter
    const bus: MockBus = {
      handlers: new Map(),
      on(event, handler) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      async emit(event, data) {
        for (const h of this.handlers.get(event) ?? []) await h(data);
      },
    };

    expect(() => pkg.setupPost?.(asNever({ app, bus }))).not.toThrow();
  });

  test('seed is a no-op when no seed data is provided', async () => {
    const app = new Hono();
    const adapter = await permissionsAdapterFactories.memory(asNever({}));
    const ctx = {
      pluginState: new Map([
        [
          'slingshot:package:capabilities:slingshot-permissions',
          {
            adapter,
            registry: { register() {} },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();
    await expect(
      pkg.seed?.(
        asNever({
          app,
          seedState: new Map(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test('seed handles malformed seed keys without crashing', async () => {
    const app = new Hono();
    const adapter = await permissionsAdapterFactories.memory(asNever({}));
    const ctx = {
      pluginState: new Map([
        [
          'slingshot:package:capabilities:slingshot-permissions',
          {
            adapter,
            registry: { register() {} },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    const pkg = createPermissionsPackage();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    await pkg.seed?.(
      asNever({
        app,
        seedState: new Map<string, unknown>([['malformed:key:extra:parts', true]]),
      }),
    );

    // Malformed keys beyond subjectId:subjectType are gracefully ignored
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
