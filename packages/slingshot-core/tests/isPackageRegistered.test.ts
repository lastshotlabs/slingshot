/**
 * Detection invariants for `isPackageRegistered(app, packageName)`.
 *
 * The helper is the canonical way for sibling packages to detect each
 * other's presence without importing typed capability handles. It reads
 * the `slingshot:package:capabilities:<pkg>` slot that
 * `publishPackageRuntimeState()` writes for every registered
 * `definePackage(...)`-authored package.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  PACKAGE_CAPABILITIES_PREFIX,
  attachContext,
  isPackageRegistered,
} from '../src/index';

function buildApp(registeredPackages: readonly string[] = []): Hono {
  const app = new Hono();
  const pluginState = new Map<string, unknown>();
  for (const pkg of registeredPackages) {
    pluginState.set(`${PACKAGE_CAPABILITIES_PREFIX}${pkg}`, {});
  }
  attachContext(app, {
    app,
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus: { on() {}, emit() {}, drain: async () => {} },
  } as unknown as Parameters<typeof attachContext>[1]);
  return app;
}

describe('isPackageRegistered', () => {
  test('returns true for a registered package', () => {
    const app = buildApp(['slingshot-assets']);
    expect(isPackageRegistered(app, 'slingshot-assets')).toBe(true);
  });

  test('returns false for a missing package', () => {
    const app = buildApp(['slingshot-polls']);
    expect(isPackageRegistered(app, 'slingshot-assets')).toBe(false);
  });

  test('returns false when the app has no SlingshotContext attached', () => {
    const app = new Hono();
    expect(isPackageRegistered(app, 'slingshot-assets')).toBe(false);
  });

  test('returns false when capabilityProviders has not been written yet', () => {
    const app = buildApp([]);
    expect(isPackageRegistered(app, 'slingshot-assets')).toBe(false);
  });

  test('discriminates between packages with overlapping prefixes', () => {
    // Two packages whose names share a prefix must not be conflated.
    const app = buildApp(['slingshot-assets-foo']);
    expect(isPackageRegistered(app, 'slingshot-assets')).toBe(false);
    expect(isPackageRegistered(app, 'slingshot-assets-foo')).toBe(true);
  });
});
