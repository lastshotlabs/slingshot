/**
 * Tests for server-level permissions bootstrap.
 *
 * Verifies that `createApp` with `permissions: { adapter: 'memory' }` populates
 * `ctx.pluginState` at `PERMISSIONS_STATE_KEY` before any plugin lifecycle phase.
 */
import { afterEach, expect, test } from 'bun:test';
import type { PermissionsState, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, getContext } from '@lastshotlabs/slingshot-core';
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
  let stateAtSetupRoutes: unknown;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      stateAtSetupRoutes = getContext(app).pluginState.get(PERMISSIONS_STATE_KEY);
    },
  };

  const result = await createApp({
    ...baseConfig,
    permissions: { adapter: 'memory' },
    plugins: [probe],
  });
  createdApps.push(result);

  expect(stateAtSetupRoutes).toBeDefined();
  expect(Object.isFrozen(stateAtSetupRoutes)).toBe(true);
  const state = stateAtSetupRoutes as PermissionsState;
  expect(typeof state.evaluator.can).toBe('function');
  expect(typeof state.registry.register).toBe('function');
  expect(typeof state.adapter.createGrant).toBe('function');
});

test('server-level permissions bootstrap populates pluginState before setupMiddleware', async () => {
  let stateAtSetupMiddleware: unknown;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupMiddleware({ app }) {
      stateAtSetupMiddleware = getContext(app).pluginState.get(PERMISSIONS_STATE_KEY);
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
  let hasKey = true;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      hasKey = getContext(app).pluginState.has(PERMISSIONS_STATE_KEY);
    },
  };

  const result = await createApp({
    ...baseConfig,
    plugins: [probe],
  });
  createdApps.push(result);

  expect(hasKey).toBe(false);
});

test('permissions state is frozen at bootstrap', async () => {
  let state: PermissionsState | undefined;
  const probe: SlingshotPlugin = {
    name: 'probe',
    async setupRoutes({ app }) {
      state = getContext(app).pluginState.get(PERMISSIONS_STATE_KEY) as PermissionsState;
    },
  };

  const result = await createApp({
    ...baseConfig,
    permissions: { adapter: 'memory' },
    plugins: [probe],
  });
  createdApps.push(result);

  expect(state).toBeDefined();
  expect(Object.isFrozen(state)).toBe(true);
});

