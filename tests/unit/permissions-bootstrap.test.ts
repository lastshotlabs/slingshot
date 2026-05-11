/**
 * Tests for server-level permissions bootstrap.
 *
 * Verifies that `createApp` with `permissions: { adapter: 'memory' }` populates
 * `ctx.pluginState` at `PERMISSIONS_STATE_KEY` before any plugin lifecycle phase.
 */
import { afterEach, expect, test } from 'bun:test';
import type { PermissionsState, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getContext, getPermissionsStateOrNull } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

// ---------------------------------------------------------------------------
// Shared config — avoids real DB connections
// ---------------------------------------------------------------------------

const baseConfig = {
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  logging: { onLog: () => {} },
};

const createdApps: Array<{ ctx: { destroy(): Promise<void> } }> = [];

afterEach(async () => {
  for (const app of createdApps.splice(0)) {
    await app.ctx.destroy().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Bootstrap tests
// ---------------------------------------------------------------------------

test('server-level permissions bootstrap populates pluginState before setupRoutes', async () => {
  let stateAtSetupRoutes: PermissionsState | null = null;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      stateAtSetupRoutes = getPermissionsStateOrNull(getContext(app).pluginState);
    },
  };

  const result = await createApp({
    ...baseConfig,
    permissions: { adapter: 'memory' },
    plugins: [probe],
  });
  createdApps.push(result);

  expect(stateAtSetupRoutes).toBeDefined();
  const state = stateAtSetupRoutes as unknown as PermissionsState;
  expect(typeof state.evaluator.can).toBe('function');
  expect(typeof state.registry.register).toBe('function');
  expect(typeof state.adapter.createGrant).toBe('function');
});

test('server-level permissions bootstrap populates pluginState before setupMiddleware', async () => {
  let stateAtSetupMiddleware: PermissionsState | null = null;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupMiddleware({ app }) {
      stateAtSetupMiddleware = getPermissionsStateOrNull(getContext(app).pluginState);
    },
  };

  const result = await createApp({
    ...baseConfig,
    permissions: { adapter: 'memory' },
    plugins: [probe],
  });
  createdApps.push(result);

  expect(stateAtSetupMiddleware).toBeDefined();
});

test('omitting permissions leaves pluginState without PERMISSIONS_STATE_KEY', async () => {
  let resolved: PermissionsState | null = null;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      resolved = getPermissionsStateOrNull(getContext(app).pluginState);
    },
  };

  const result = await createApp({
    ...baseConfig,
    plugins: [probe],
  });
  createdApps.push(result);

  expect(resolved).toBeNull();
});

test('permissions state is reachable through getPermissionsStateOrNull at bootstrap', async () => {
  let state: PermissionsState | null = null;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      state = getPermissionsStateOrNull(getContext(app).pluginState);
    },
  };

  const result = await createApp({
    ...baseConfig,
    permissions: { adapter: 'memory' },
    plugins: [probe],
  });
  createdApps.push(result);

  expect(state).toBeDefined();
  const resolved = state as unknown as PermissionsState;
  expect(typeof resolved.evaluator.can).toBe('function');
});
