/**
 * Tests for the adminGate startup warning in createSearchPlugin.
 *
 * Verifies that when admin routes are not disabled and no adminGate is configured,
 * a console.warn is emitted. No warning when adminGate is set or routes are disabled.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { createSearchPlugin } from '../src/plugin';
import { SEARCH_ROUTES } from '../src/routes/index';
import type { SearchAdminGate } from '../src/types/config';

// ---------------------------------------------------------------------------
// Minimal PluginSetupContext stub for setupRoutes
// ---------------------------------------------------------------------------

function makeSetupContext() {
  const app = new Hono();
  const context = {
    app,
    config: {
      storeInfra: {} as unknown,
      entityRegistry: { filter: () => [], getAll: () => [] },
    } as unknown,
    bus: {} as unknown,
    events: { get: () => null, register: () => {} } as unknown,
  };
  return context as unknown as Parameters<
    NonNullable<ReturnType<typeof createSearchPlugin>['setupRoutes']>
  >[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSearchPlugin — adminGate startup warning', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits a console.warn when adminGate is not set and ADMIN route is not disabled', () => {
    const plugin = createSearchPlugin({
      providers: {
        default: { provider: 'db-native' },
      },
    });

    plugin.setupRoutes!(makeSetupContext());

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      warnMessages.some((m: string) => m.includes('[slingshot-search]') && m.includes('adminGate')),
    ).toBe(true);
  });

  it('does not emit a warning when adminGate IS set', () => {
    const adminGate: SearchAdminGate = {
      verifyRequest: async () => true,
    };

    const plugin = createSearchPlugin({
      providers: {
        default: { provider: 'db-native' },
      },
      adminGate,
    });

    plugin.setupRoutes!(makeSetupContext());

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((m: string) => m.includes('adminGate'))).toBe(false);
  });

  it('does not emit a warning when the ADMIN route is explicitly disabled', () => {
    const plugin = createSearchPlugin({
      providers: {
        default: { provider: 'db-native' },
      },
      disableRoutes: [SEARCH_ROUTES.ADMIN],
    });

    plugin.setupRoutes!(makeSetupContext());

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((m: string) => m.includes('adminGate'))).toBe(false);
  });
});
