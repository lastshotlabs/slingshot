import { describe, expect, it, spyOn } from 'bun:test';
import type { PluginSetupContext } from '@lastshotlabs/slingshot-core';
import { createAssetsPlugin } from '../../src/plugin';

/**
 * Build a minimal `PluginSetupContext` shape good enough to call `setupPost`
 * directly. The orphan-delete check executes before any inner-plugin wiring,
 * so it does not depend on `app`, `bus`, or `events`.
 */
function makeStubContext(): PluginSetupContext {
  return {
    app: {} as unknown as PluginSetupContext['app'],
    config: {} as unknown as PluginSetupContext['config'],
    bus: {} as unknown as PluginSetupContext['bus'],
    events: {} as unknown as PluginSetupContext['events'],
  };
}

describe('createAssetsPlugin startup orphan-delete guard', () => {
  it('throws ASSETS_DELETE_MIDDLEWARE_MISSING when delete middleware was not wired', async () => {
    const plugin = createAssetsPlugin({ storage: { adapter: 'memory' } });
    // Skip setupMiddleware/setupRoutes so the manifest runtime never wires
    // the storage-delete middleware. setupPost must refuse to start.
    let captured: unknown = null;
    try {
      await plugin.setupPost?.(makeStubContext());
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain('storage-delete middleware was not wired');
    expect((captured as Error & { code?: string }).code).toBe('ASSETS_DELETE_MIDDLEWARE_MISSING');
  });

  it('warns and proceeds when allowOrphanedStorage: true is set', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plugin = createAssetsPlugin({
        storage: { adapter: 'memory' },
        allowOrphanedStorage: true,
      });
      await expect(plugin.setupPost?.(makeStubContext())).resolves.toBeUndefined();
      // Confirm the warning was logged.
      const warnedAboutOrphans = warnSpy.mock.calls.some(call =>
        String(call[0] ?? '').includes('allowOrphanedStorage'),
      );
      expect(warnedAboutOrphans).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('plugin construction succeeds with allowOrphanedStorage: true', () => {
    expect(() =>
      createAssetsPlugin({
        storage: { adapter: 'memory' },
        allowOrphanedStorage: true,
      }),
    ).not.toThrow();
  });

  it('plugin construction succeeds with allowOrphanedStorage omitted (default false)', () => {
    expect(() => createAssetsPlugin({ storage: { adapter: 'memory' } })).not.toThrow();
  });
});
