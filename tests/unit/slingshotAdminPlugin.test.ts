import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AUTH_RUNTIME_KEY } from '@lastshotlabs/slingshot-auth/testing';
import { PERMISSIONS_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext } from '@lastshotlabs/slingshot-core';

const mockAdminSetupRoutes = mock(async () => {});
const mockCreateAdminPlugin = mock(() => ({
  name: 'admin',
  setupRoutes: mockAdminSetupRoutes,
}));

async function loadCreateSlingshotAdminPlugin() {
  mockCreateAdminPlugin.mockImplementation(() => ({
    name: 'admin',
    setupRoutes: mockAdminSetupRoutes,
  }));

  mock.module('@lastshotlabs/slingshot-admin', () => ({
    createAdminPlugin: mockCreateAdminPlugin,
  }));

  const mod = await import(`../../src/framework/admin/index.ts?admin-plugin=${Date.now()}`);
  return mod.createSlingshotAdminPlugin;
}

afterEach(() => {
  mock.restore();
  mockCreateAdminPlugin.mockReset();
  mockAdminSetupRoutes.mockReset();
});

function makePermissionsState() {
  return {
    adapter: { createGrant: async () => {} },
    registry: { register: () => {} },
    evaluator: { can: async () => true },
  };
}

function createAuthRuntime() {
  return {
    adapter: {},
    config: {
      admin: {},
      roles: ['admin'],
      defaultRole: 'admin',
    },
    repos: {
      session: {},
    },
  };
}

function makeCtx(existingPermissions?: unknown): {
  ctx: PluginSetupContext;
  pluginState: Map<string | symbol, unknown>;
} {
  const pluginState = new Map<string | symbol, unknown>();
  if (existingPermissions !== undefined) {
    pluginState.set(PERMISSIONS_STATE_KEY, existingPermissions);
  }
  pluginState.set(AUTH_RUNTIME_KEY, createAuthRuntime());

  const app = { pluginState };
  const config = { meta: { name: 'Test App' } } as unknown as PluginSetupContext['config'];
  const ctx: PluginSetupContext = {
    app: app as unknown as PluginSetupContext['app'],
    config,
    bus: {
      on: () => {},
      off: () => {},
      emit: () => {},
      ensureClientSafeEventKey: (k: string) => k,
    } as unknown as PluginSetupContext['bus'],
  };

  return { ctx, pluginState };
}

describe('createSlingshotAdminPlugin', () => {
  test('returns a plugin with name "slingshot-admin"', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const plugin = createSlingshotAdminPlugin({});
    expect(plugin.name).toBe('slingshot-admin');
  });

  test('plugin exposes setupPost and setup lifecycle methods', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const plugin = createSlingshotAdminPlugin({});
    expect(typeof plugin.setupPost).toBe('function');
    expect(typeof plugin.setup).toBe('function');
  });

  test('setupPost throws when no permissions provided and pluginState lacks valid permissions state', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const plugin = createSlingshotAdminPlugin({});
    const { ctx } = makeCtx();

    await expect(plugin.setupPost!(ctx)).rejects.toThrow(
      'permissions not provided and not found in pluginState',
    );
  });

  test('setupPost resolves permissions from pluginState when not explicitly provided', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    expect(mockCreateAdminPlugin).toHaveBeenCalledTimes(1);
    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.permissions).toBe(fakePermissions);
  });

  test('setupPost uses explicit permissions from config and ignores pluginState fallback', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const explicitPermissions = makePermissionsState();
    const statePermissions = makePermissionsState();
    const { ctx } = makeCtx(statePermissions);

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.permissions).toBe(explicitPermissions);
  });

  test('setupPost publishes resolved permissions to pluginState when key is absent', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const explicitPermissions = makePermissionsState();
    const { ctx, pluginState } = makeCtx();

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    expect(pluginState.get(PERMISSIONS_STATE_KEY)).toBe(explicitPermissions);
  });

  test('setupPost does not overwrite existing PERMISSIONS_STATE_KEY in pluginState', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const existingPermissions = makePermissionsState();
    const explicitPermissions = makePermissionsState();
    const { ctx, pluginState } = makeCtx(existingPermissions);

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    expect(pluginState.get(PERMISSIONS_STATE_KEY)).toBe(existingPermissions);
  });

  test('setup calls setupPost internally', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setup!(ctx);

    expect(mockCreateAdminPlugin).toHaveBeenCalledTimes(1);
  });

  test('setupPost calls setupRoutes on the inner admin plugin', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    expect(mockAdminSetupRoutes).toHaveBeenCalledTimes(1);
  });

  test('uses default accessProvider and managedUserProvider when not configured', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.accessProvider).toBeDefined();
    expect(callArg.managedUserProvider).toBeDefined();
  });

  test('uses custom accessProvider when provided', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const customProvider = { canAccess: async () => false };
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({
      accessProvider: customProvider as never,
    });
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.accessProvider).toBe(customProvider);
  });

  test('uses custom managedUserProvider when provided', async () => {
    const createSlingshotAdminPlugin = await loadCreateSlingshotAdminPlugin();
    const customManagedUserProvider = { list: async () => [] };
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({
      managedUserProvider: customManagedUserProvider as never,
    });
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.managedUserProvider).toBe(customManagedUserProvider);
  });
});
