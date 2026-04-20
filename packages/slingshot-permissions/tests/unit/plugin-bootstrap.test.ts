import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PERMISSIONS_STATE_KEY, attachContext } from '@lastshotlabs/slingshot-core';
import { permissionsAdapterFactories } from '../../src/factories';
import { seedSuperAdmin } from '../../src/lib/bootstrap';
import { createPermissionsPlugin } from '../../src/plugin';

function asNever<T>(v: T): never {
  return v as never;
}

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

    const grantId = await seedSuperAdmin(asNever({ createGrant }), {
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

    await expect(
      seedSuperAdmin(asNever({ createGrant }), {
        subjectId: 'svc-1',
        subjectType: 'service-account',
        grantedBy: 'migration',
      }),
    ).resolves.toBe('grant-2');
  });

  test('permissionsAdapterFactories reject redis stores instead of silently falling back', async () => {
    const memoryAdapter = await permissionsAdapterFactories.memory(asNever({}));

    expect(typeof memoryAdapter.createGrant).toBe('function');
    expect(() => permissionsAdapterFactories.redis(asNever({}))).toThrow(
      'Redis permissions adapter is not implemented',
    );
  });

  test('permissionsAdapterFactories.mongo calls infra.getMongo() and creates adapter', () => {
    const conn = { model: () => ({}) };
    const infra = { getMongo: () => ({ conn }) };
    const adapter = permissionsAdapterFactories.mongo(infra as never);
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

  test('createPermissionsPlugin wires auth-backed group resolution into the evaluator', async () => {
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

    const state = ctx.pluginState.get(PERMISSIONS_STATE_KEY) as
      | {
          evaluator: {
            can: (
              subject: { subjectId: string; subjectType: 'user' },
              action: string,
              scope?: object,
            ) => Promise<boolean>;
          };
          registry: {
            register: (def: { resourceType: string; roles: Record<string, string[]> }) => void;
          };
          adapter: { createGrant: (grant: Record<string, unknown>) => Promise<string> };
        }
      | undefined;
    expect(state).toBeDefined();

    state!.registry.register({
      resourceType: 'post',
      roles: { editor: ['read'] },
    });
    await state!.adapter.createGrant({
      subjectId: 'group-alpha',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    await expect(
      state!.evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).resolves.toBe(true);
  });
});
