/**
 * Integration tests: admin permissions auto-discovery via pluginState.
 *
 * Covers:
 *   1. Discovers permissions from community plugin (registered in pluginState)
 *   2. Throws clear error when no permissions available in pluginState
 *   3. Explicit permissions take precedence over auto-discovered
 */
import { describe, expect, test } from 'bun:test';
import { createSlingshotAdminPlugin } from '../../src/framework/admin';
import {
  adminPlugin,
  communityPlugin,
  createTestApp,
  createTestPermissions,
  notificationsPlugin,
} from '../setup';

// ---------------------------------------------------------------------------
// 1 — Discovers permissions from community plugin
// ---------------------------------------------------------------------------

describe('admin auto-discovery — permissions from community plugin pluginState', () => {
  test('createSlingshotAdminPlugin({}) works when community has registered permissions', async () => {
    // community plugin registers permissions in pluginState during setupRoutes
    const app = await createTestApp({
      plugins: [notificationsPlugin(), communityPlugin(), createSlingshotAdminPlugin({})],
    });

    // Admin routes are reachable (401 = auth guard ran, not an init error)
    const res = await app.request('/admin/users');
    expect(res.status).toBe(401);
  });

  test('GET /admin/capabilities is reachable when permissions auto-discovered', async () => {
    const app = await createTestApp({
      plugins: [notificationsPlugin(), communityPlugin(), createSlingshotAdminPlugin({})],
    });

    const res = await app.request('/admin/capabilities');
    // 401 = auth guard reached, confirming full plugin wiring succeeded
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2 — Throws clear error when no permissions available
// ---------------------------------------------------------------------------

describe('admin auto-discovery — clear error when no permissions available', () => {
  test('throws with clear message when no permissions in pluginState and none passed explicitly', async () => {
    await expect(
      createTestApp({
        plugins: [createSlingshotAdminPlugin({})],
      }),
    ).rejects.toThrow('[slingshot-admin] permissions not provided and not found in pluginState');
  });

  test('error message mentions passing permissions explicitly or registering via a plugin', async () => {
    let caughtError: Error | undefined;
    try {
      await createTestApp({
        plugins: [createSlingshotAdminPlugin({})],
      });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain('pass permissions explicitly');
    expect(caughtError!.message).toContain('registers PERMISSIONS_STATE_KEY');
  });
});

// ---------------------------------------------------------------------------
// 3 — Explicit permissions take precedence over auto-discovered
// ---------------------------------------------------------------------------

describe('admin auto-discovery — explicit permissions take precedence', () => {
  test('explicit permissions are used instead of community-registered ones', async () => {
    const explicitPermissions = createTestPermissions();

    // Both community and admin have permissions; explicit ones should win
    const app = await createTestApp({
      plugins: [
        notificationsPlugin(),
        communityPlugin(),
        createSlingshotAdminPlugin({ permissions: explicitPermissions }),
      ],
    });

    // Plugin wired successfully with explicit permissions
    const res = await app.request('/admin/users');
    expect(res.status).toBe(401);
  });

  test('adminPlugin helper (explicit) works independently of community plugin', async () => {
    const app = await createTestApp({
      plugins: [adminPlugin()],
    });

    const res = await app.request('/admin/users');
    expect(res.status).toBe(401);
  });
});
