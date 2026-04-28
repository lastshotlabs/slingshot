import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  PERMISSIONS_STATE_KEY,
  attachContext,
  getAuthRuntimePeerOrNull,
} from '@lastshotlabs/slingshot-core';
import { permissionsAdapterFactories } from '../../src/factories';
import { createAuthGroupResolver } from '../../src/lib/authGroupResolver';
import { seedSuperAdmin } from '../../src/lib/bootstrap';
import { createPermissionsPlugin } from '../../src/plugin';

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

describe('slingshot-permissions bootstrap and plugin wiring', () => {
  test('seedSuperAdmin writes a global super-admin allow grant with defaults', async () => {
    const createGrant = mock(async input => {
      expect(input).toMatchObject({
        subjectId: 'user-1',
        subjectType: 'user',
        tenantId: null,
        resourceType: null,
        resourceId: null,
        roles: ['super-admin'],
        effect: 'allow',
        grantedBy: 'bootstrap',
      });
      return 'grant-1';
    });
    const getGrantsForSubject = mock(async () => []);

    const grantId = await seedSuperAdmin(asNever({ createGrant, getGrantsForSubject }), {
      subjectId: 'user-1',
    });

    expect(grantId).toBe('grant-1');
    expect(createGrant).toHaveBeenCalledTimes(1);
  });

  test('seedSuperAdmin respects explicit subjectType and grantedBy', async () => {
    const createGrant = mock(async input => {
      expect(input).toMatchObject({
        subjectId: 'svc-1',
        subjectType: 'service-account',
        grantedBy: 'migration',
      });
      return 'grant-2';
    });
    const getGrantsForSubject = mock(async () => []);

    await expect(
      seedSuperAdmin(asNever({ createGrant, getGrantsForSubject }), {
        subjectId: 'svc-1',
        subjectType: 'service-account',
        grantedBy: 'migration',
      }),
    ).resolves.toBe('grant-2');
  });

  test('seedSuperAdmin is idempotent — returns existing grant ID without creating a duplicate', async () => {
    const existingGrant = {
      id: 'existing-grant-id',
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'bootstrap',
      grantedAt: new Date(),
    };
    const createGrant = mock(async () => 'new-grant-id');
    const getGrantsForSubject = mock(async () => [existingGrant]);

    const grantId = await seedSuperAdmin(asNever({ createGrant, getGrantsForSubject }), {
      subjectId: 'user-1',
    });

    expect(grantId).toBe('existing-grant-id');
    expect(createGrant).not.toHaveBeenCalled();
  });

  test('permissionsAdapterFactories reject redis stores instead of silently falling back', async () => {
    const memoryAdapter = await permissionsAdapterFactories.memory(asNever({}));

    expect(typeof memoryAdapter.createGrant).toBe('function');
    expect(() => permissionsAdapterFactories.redis(asNever({}))).toThrow(
      'Redis permissions adapter is not implemented',
    );
  });

  test('permissionsAdapterFactories.mongo calls infra.getMongo() and creates adapter', async () => {
    const conn = { model: () => ({}) };
    const infra = { getMongo: () => ({ conn }) };
    const adapter = await permissionsAdapterFactories.mongo(infra as never);
    expect(typeof adapter.createGrant).toBe('function');
  });

  test('createPermissionsPlugin rejects redis as a permissions store', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();

    await expect(
      plugin.setupMiddleware?.(
        asNever({
          app,
          config: {
            resolvedStores: { authStore: 'redis' },
            storeInfra: {},
          },
          bus: {},
        }),
      ),
    ).rejects.toThrow('Redis is not supported as a permissions store');
  });

  test('createPermissionsPlugin seeds frozen permissions state into pluginState', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();

    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: {
          resolvedStores: { authStore: 'memory' },
          storeInfra: {},
        },
        bus: {},
      }),
    );

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as Record<string, unknown> | undefined;
    expect(plugin.name).toBe('slingshot-permissions');
    expect(state).toBeDefined();
    expect(Object.isFrozen(state)).toBe(true);
    expect(typeof state?.evaluator).toBe('object');
    expect(typeof state?.registry).toBe('object');
    expect(typeof state?.adapter).toBe('object');
  });

  test('createPermissionsPlugin is idempotent when permissions state already exists', async () => {
    const app = new Hono();
    const sentinel = Object.freeze({ existing: true });
    const ctx = { pluginState: new Map([[PERMISSIONS_STATE_KEY, sentinel]]) };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();

    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: {
          resolvedStores: { authStore: 'memory' },
          storeInfra: {},
        },
        bus: {},
      }),
    );

    expect(ctx.pluginState.get(PERMISSIONS_STATE_KEY)).toBe(sentinel);
  });

  test('createPermissionsPlugin reflects a pre-seeded adapter in health', async () => {
    const app = new Hono();
    const adapter = { name: 'preseeded-adapter' };
    const sentinel = Object.freeze({ adapter });
    const ctx = { pluginState: new Map([[PERMISSIONS_STATE_KEY, sentinel]]) };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();

    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: {
          resolvedStores: { authStore: 'memory' },
          storeInfra: {},
        },
        bus: {},
      }),
    );

    expect(ctx.pluginState.get(PERMISSIONS_STATE_KEY)).toBe(sentinel);
    expect(plugin.getHealth()).toEqual({
      status: 'healthy',
      details: {
        adapterAvailable: true,
        adapterName: 'preseeded-adapter',
        evaluator: null,
      },
    });
  });

  test('createPermissionsPlugin with no groupResolver disables group expansion', async () => {
    const app = new Hono();
    const ctx = {
      pluginState: new Map([
        [
          'slingshot-auth',
          {
            adapter: {
              async getUserGroups(userId: string) {
                return userId === 'user-1'
                  ? [{ group: { id: 'group-alpha' }, membershipRoles: [] }]
                  : [];
              },
            },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    // No groupResolver — auth peer is ignored even though it's in pluginState
    const plugin = createPermissionsPlugin();

    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: { resolvedStores: { authStore: 'memory' }, storeInfra: {} },
        bus: {},
      }),
    );

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as any;
    state.registry.register({
      resourceType: 'post',
      actions: ['read'],
      roles: { editor: ['read'] },
    });
    await state.adapter.createGrant({
      subjectId: 'group-alpha',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // Group grant exists but group expansion is disabled — user-1 cannot access
    await expect(
      state.evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).resolves.toBe(false);
  });

  test('setupPost: auth:user.deleted event triggers deleteAllGrantsForSubject', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: { resolvedStores: { authStore: 'memory' }, storeInfra: {} },
        bus: {},
      }),
    );

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

    plugin.setupPost?.(asNever({ app, bus }));

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as any;
    const deleteAllSpy = mock(async (_subject: unknown) => {});
    state.adapter.deleteAllGrantsForSubject = deleteAllSpy;

    await bus.emit('auth:user.deleted', { userId: 'user-to-delete' });

    expect(deleteAllSpy).toHaveBeenCalledTimes(1);
    expect(deleteAllSpy).toHaveBeenCalledWith({
      subjectId: 'user-to-delete',
      subjectType: 'user',
    });
  });

  test('setupPost: deleteAllGrantsForSubject error is swallowed — handler does not propagate', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: { resolvedStores: { authStore: 'memory' }, storeInfra: {} },
        bus: {},
      }),
    );

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

    plugin.setupPost?.(asNever({ app, bus }));

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as any;
    state.adapter.deleteAllGrantsForSubject = mock(async () => {
      throw new Error('DB connection lost');
    });

    // Must resolve without throwing — error is swallowed by the try/catch in plugin.ts
    await expect(bus.emit('auth:user.deleted', { userId: 'user-x' })).resolves.toBeUndefined();
  });

  test('setupPost: no-op when permissions state is absent', () => {
    const app = new Hono();
    const ctx = { pluginState: new Map() };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    // setupMiddleware was NOT called, so PERMISSIONS_STATE_KEY is absent
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
    // Should not throw
    expect(() => plugin.setupPost?.(asNever({ app, bus }))).not.toThrow();
    // No handlers registered — bus is empty
    expect(bus.handlers.size).toBe(0);
  });

  test('setupPost: no-op when permissions state has no adapter', () => {
    const app = new Hono();
    const ctx = { pluginState: new Map([[PERMISSIONS_STATE_KEY, {}]]) };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
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

    expect(() => plugin.setupPost?.(asNever({ app, bus }))).not.toThrow();
    expect(bus.handlers.size).toBe(0);
  });

  test('seed: returns without adapter state', async () => {
    const app = new Hono();
    const ctx = { pluginState: new Map([[PERMISSIONS_STATE_KEY, {}]]) };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();

    await expect(
      plugin.seed?.(
        asNever({
          app,
          seedState: new Map([['superAdmin:admin@example.test', true]]),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test('seed: grants super-admin and warns when a requested user is missing', async () => {
    const app = new Hono();
    const getGrantsForSubject = mock(async () => []);
    const createGrant = mock(async () => 'grant-1');
    const ctx = {
      pluginState: new Map([
        [
          PERMISSIONS_STATE_KEY,
          {
            adapter: {
              getGrantsForSubject,
              createGrant,
            },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});

    await plugin.seed?.(
      asNever({
        app,
        seedState: new Map<string, unknown>([
          ['superAdmin:missing@example.test', true],
          ['superAdmin:admin@example.test', true],
          ['user:admin@example.test', 'user-1'],
          ['superAdmin:disabled@example.test', false],
        ]),
      }),
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing@example.test'));
    expect(getGrantsForSubject).toHaveBeenCalledWith('user-1', 'user', {
      tenantId: null,
      resourceType: null,
      resourceId: null,
    });
    expect(createGrant).toHaveBeenCalledWith({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'manifest-seed',
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Granted super-admin'));
  });

  test('seed: skips users that already have a live super-admin grant', async () => {
    const app = new Hono();
    const getGrantsForSubject = mock(async () => [
      {
        id: 'existing-admin',
        roles: ['super-admin'],
        effect: 'allow',
        revokedAt: null,
      },
    ]);
    const createGrant = mock(async () => 'grant-1');
    const ctx = {
      pluginState: new Map([
        [
          PERMISSIONS_STATE_KEY,
          {
            adapter: {
              getGrantsForSubject,
              createGrant,
            },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin();
    const log = spyOn(console, 'log').mockImplementation(() => {});

    await plugin.seed?.(
      asNever({
        app,
        seedState: new Map<string, unknown>([
          ['superAdmin:admin@example.test', true],
          ['user:admin@example.test', 'user-1'],
        ]),
      }),
    );

    expect(createGrant).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already has super-admin'));
  });

  test('createPermissionsPlugin with groupResolver wires auth-backed group expansion', async () => {
    const app = new Hono();
    const ctx = {
      pluginState: new Map([
        [
          'slingshot-auth',
          {
            adapter: {
              async getUserGroups(userId: string) {
                return userId === 'user-1'
                  ? [{ group: { id: 'group-alpha' }, membershipRoles: [] }]
                  : [];
              },
            },
          },
        ],
      ]),
    };
    attachContext(app, ctx as never);

    const plugin = createPermissionsPlugin({
      groupResolver: pluginState =>
        createAuthGroupResolver(() => getAuthRuntimePeerOrNull(pluginState)),
    });

    await plugin.setupMiddleware?.(
      asNever({
        app,
        config: { resolvedStores: { authStore: 'memory' }, storeInfra: {} },
        bus: {},
      }),
    );

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as any;
    state.registry.register({
      resourceType: 'post',
      actions: ['read'],
      roles: { editor: ['read'] },
    });
    await state.adapter.createGrant({
      subjectId: 'group-alpha',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // Group resolver is wired — user-1 is in group-alpha, group-alpha has editor role
    await expect(
      state.evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).resolves.toBe(true);
  });
});
