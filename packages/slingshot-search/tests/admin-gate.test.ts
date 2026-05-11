/**
 * Tests for the adminGate startup warning in createSearchPackage.
 *
 * Verifies that when admin routes are not disabled and no adminGate is configured,
 * a warning is emitted. No warning when adminGate is set or routes are disabled.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { LogFields, Logger } from '@lastshotlabs/slingshot-core';
import { createSearchPackage } from '../src/plugin';
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
    NonNullable<ReturnType<typeof createSearchPackage>['setupRoutes']>
  >[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSearchPackage — adminGate startup warning', () => {
  let warnings: string[];
  let logger: Logger;

  beforeEach(() => {
    warnings = [];
    logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      child() {
        return logger;
      },
    };
  });

  it('emits a warning when adminGate is not set and ADMIN route is not disabled', () => {
    const pkg = createSearchPackage(
      {
        providers: {
          default: { provider: 'db-native' },
        },
      },
      { logger },
    );

    pkg.setupRoutes!(makeSetupContext());

    expect(warnings.some(m => m.includes('[slingshot-search]') && m.includes('adminGate'))).toBe(
      true,
    );
  });

  it('does not emit a warning when adminGate IS set', () => {
    const adminGate: SearchAdminGate = {
      verifyRequest: async () => true,
    };

    const pkg = createSearchPackage(
      {
        providers: {
          default: { provider: 'db-native' },
        },
        adminGate,
      },
      { logger },
    );

    pkg.setupRoutes!(makeSetupContext());

    expect(warnings.some(m => m.includes('adminGate'))).toBe(false);
  });

  it('does not emit a warning when the ADMIN route is explicitly disabled', () => {
    const pkg = createSearchPackage(
      {
        providers: {
          default: { provider: 'db-native' },
        },
        disableRoutes: [SEARCH_ROUTES.ADMIN],
      },
      { logger },
    );

    pkg.setupRoutes!(makeSetupContext());

    expect(warnings.some(m => m.includes('adminGate'))).toBe(false);
  });
});
