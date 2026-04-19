import { describe, expect, mock, test } from 'bun:test';
import { PERMISSIONS_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext } from '@lastshotlabs/slingshot-core';
import { createSlingshotAdminPlugin } from '../../src/framework/admin';

// ---------------------------------------------------------------------------
// Mock @lastshotlabs/slingshot-admin
// ---------------------------------------------------------------------------

const mockAdminSetupRoutes = mock(async () => {});
const mockCreateAdminPlugin = mock(() => ({
  name: 'admin',
  setupRoutes: mockAdminSetupRoutes,
}));

mock.module('@lastshotlabs/slingshot-admin', () => ({
  createAdminPlugin: mockCreateAdminPlugin,
}));

// ---------------------------------------------------------------------------
// Mock @lastshotlabs/slingshot-auth (getAuthRuntimeContext)
// ---------------------------------------------------------------------------

mock.module('@lastshotlabs/slingshot-auth', () => ({
  createSlingshotAuthAccessProvider: () => ({ canAccess: async () => true }),
  createSlingshotManagedUserProvider: () => ({ list: async () => [] }),
  getAuthRuntimeContext: () => ({
    adapter: {},
    config: {},
    repos: { session: {} },
    password: { hash: async (p: string) => p },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers — PermissionsState requires adapter + registry + evaluator
// ---------------------------------------------------------------------------

function makePermissionsState() {
  return {
    adapter: { createGrant: async () => {} },
    registry: { register: () => {} },
    evaluator: { can: async () => true },
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

  // getPluginState reads app.pluginState
  const app = { pluginState };

  const ctx: PluginSetupContext = {
    app: app as unknown as PluginSetupContext['app'],
    config: { meta: { name: 'Test App' } } as PluginSetupContext['config'],
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
  test('returns a plugin with name "slingshot-admin"', () => {
    const plugin = createSlingshotAdminPlugin({});
    expect(plugin.name).toBe('slingshot-admin');
  });

  test('plugin exposes setupPost and setup lifecycle methods', () => {
    const plugin = createSlingshotAdminPlugin({});
    expect(typeof plugin.setupPost).toBe('function');
    expect(typeof plugin.setup).toBe('function');
  });

  test('setupPost throws when no permissions provided and pluginState lacks valid permissions state', async () => {
    const plugin = createSlingshotAdminPlugin({});
    // No permissions at all
    const { ctx } = makeCtx();

    await expect(plugin.setupPost!(ctx)).rejects.toThrow(
      'permissions not provided and not found in pluginState',
    );
  });

  test('setupPost resolves permissions from pluginState when not explicitly provided', async () => {
    mockCreateAdminPlugin.mockClear();
    mockAdminSetupRoutes.mockClear();

    // PermissionsState requires adapter + registry + evaluator to be truthy
    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    expect(mockCreateAdminPlugin).toHaveBeenCalledTimes(1);
    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.permissions).toBe(fakePermissions);
  });

  test('setupPost uses explicit permissions from config — takes precedence over pluginState', async () => {
    mockCreateAdminPlugin.mockClear();

    const explicitPermissions = makePermissionsState();
    const statePermissions = makePermissionsState();
    const { ctx } = makeCtx(statePermissions);

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.permissions).toBe(explicitPermissions);
  });

  test('setupPost publishes resolved permissions to pluginState when key is absent', async () => {
    mockCreateAdminPlugin.mockClear();

    const explicitPermissions = makePermissionsState();
    const { ctx, pluginState } = makeCtx(); // no existing permissions

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    // Admin plugin should have set PERMISSIONS_STATE_KEY in pluginState
    expect(pluginState.get(PERMISSIONS_STATE_KEY)).toBe(explicitPermissions);
  });

  test('setupPost does not overwrite existing PERMISSIONS_STATE_KEY in pluginState', async () => {
    mockCreateAdminPlugin.mockClear();

    const existingPermissions = makePermissionsState();
    const explicitPermissions = makePermissionsState();
    const { ctx, pluginState } = makeCtx(existingPermissions);

    const plugin = createSlingshotAdminPlugin({ permissions: explicitPermissions as never });
    await plugin.setupPost!(ctx);

    // Existing key should remain — not overwritten
    expect(pluginState.get(PERMISSIONS_STATE_KEY)).toBe(existingPermissions);
  });

  test('setup calls setupPost internally', async () => {
    mockCreateAdminPlugin.mockClear();

    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setup!(ctx);

    expect(mockCreateAdminPlugin).toHaveBeenCalledTimes(1);
  });

  test('setupPost calls setupRoutes on the inner admin plugin', async () => {
    mockAdminSetupRoutes.mockClear();

    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    expect(mockAdminSetupRoutes).toHaveBeenCalledTimes(1);
  });

  test('uses default accessProvider and managedUserProvider when not configured', async () => {
    mockCreateAdminPlugin.mockClear();

    const fakePermissions = makePermissionsState();
    const { ctx } = makeCtx(fakePermissions);

    const plugin = createSlingshotAdminPlugin({});
    await plugin.setupPost!(ctx);

    const callArg = mockCreateAdminPlugin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.accessProvider).toBeDefined();
    expect(callArg.managedUserProvider).toBeDefined();
  });

  test('uses custom accessProvider when provided', async () => {
    mockCreateAdminPlugin.mockClear();

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
    mockCreateAdminPlugin.mockClear();

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
