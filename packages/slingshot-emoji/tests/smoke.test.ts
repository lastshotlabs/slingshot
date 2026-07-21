import { afterEach, describe, expect, test } from 'bun:test';
import {
  PERMISSIONS_STATE_KEY,
  type PluginSetupContext,
  type SlingshotPlugin,
  getContext,
  provideCapability,
  registerPluginCapabilities,
} from '@lastshotlabs/slingshot-core';
import {
  PermissionsAdapterCap,
  PermissionsEvaluatorCap,
  PermissionsRegistryCap,
} from '@lastshotlabs/slingshot-permissions';
import { createTestApp, createTestPermissions } from '../../../tests/setup';
import { createEmojiPackage } from '../src/plugin';

const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

function testPermissionsPlugin(): SlingshotPlugin {
  const state = createTestPermissions();
  return {
    name: PERMISSIONS_STATE_KEY,
    async setupMiddleware(ctx: PluginSetupContext) {
      await registerPluginCapabilities(getContext(ctx.app), PERMISSIONS_STATE_KEY, [
        provideCapability(PermissionsEvaluatorCap, () => state.evaluator),
        provideCapability(PermissionsRegistryCap, () => state.registry),
        provideCapability(PermissionsAdapterCap, () => state.adapter),
      ]);
    },
  };
}

describe('slingshot-emoji package', () => {
  test('boots cleanly and mounts the entity create route', async () => {
    const app = await createTestApp({
      plugins: [testPermissionsPlugin()],
      packages: [createEmojiPackage({})],
    });
    createdApps.push((app as unknown as { ctx: { destroy(): Promise<void> } }).ctx);

    // Unauthenticated POST to the create route — auth intercepts first, but a
    // non-404 confirms the route is registered at the expected path.
    const response = await app.request('/emoji/emojis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shortcode: 'valid_code',
        name: 'Test',
        uploadKey: 'uploads/test.png',
      }),
    });

    expect(response.status).not.toBe(404);
  });

  test('emits deprecation warning when presignExpirySeconds is provided', () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => {
      warnings.push(String(msg));
    };
    try {
      createEmojiPackage({ presignExpirySeconds: 1800 });
      expect(warnings.some(w => w.includes('presignExpirySeconds'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test('returns a package definition with expected shape', () => {
    const pkg = createEmojiPackage({ mountPath: '/emoji' });
    expect(pkg.kind).toBe('package');
    expect(pkg.name).toBe('slingshot-emoji');
    expect(pkg.mountPath).toBe('/emoji');
    expect(pkg.entities).toHaveLength(1);
    expect(pkg.entities[0]?.entityName).toBe('Emoji');
    expect(pkg.dependencies).toContain('slingshot-auth');
    expect(pkg.dependencies).toContain('slingshot-permissions');
    expect(pkg.middleware).toHaveProperty('shortcodeGuard');
  });
});
