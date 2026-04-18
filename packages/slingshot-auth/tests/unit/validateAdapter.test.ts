import { describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { validateAdapterCapabilities } from '../../src/lib/validateAdapter';
import type { AdapterValidationConfig } from '../../src/lib/validateAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_CFG: AdapterValidationConfig = {
  hasOAuthProviders: false,
  hasMfa: false,
  hasMfaWebAuthn: false,
  hasRoles: false,
  hasDefaultRole: false,
  hasGroups: false,
  hasSuspension: false,
  hasM2m: false,
  hasAdminApi: false,
  hasPasswordReset: false,
  hasPreventReuse: false,
  hasScim: false,
};

/** Minimal adapter that satisfies core-only validation. */
function coreAdapter(): Partial<AuthAdapter> {
  return {
    verifyPassword: async () => false,
    getIdentifier: async () => null as unknown as string,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adapter capability validation at startup', () => {
  test('minimal adapter passes validation when no optional features are enabled', () => {
    expect(() =>
      validateAdapterCapabilities(coreAdapter() as AuthAdapter, MINIMAL_CFG),
    ).not.toThrow();
  });

  test('missing OAuth methods throw when hasOAuthProviders=true', () => {
    const cfg: AdapterValidationConfig = { ...MINIMAL_CFG, hasOAuthProviders: true };
    // Adapter has no OAuth methods
    expect(() => validateAdapterCapabilities(coreAdapter() as AuthAdapter, cfg)).toThrow(
      /findOrCreateByProvider/,
    );
  });

  test('missing M2M methods throw when hasM2m=true', () => {
    const cfg: AdapterValidationConfig = { ...MINIMAL_CFG, hasM2m: true };
    expect(() => validateAdapterCapabilities(coreAdapter() as AuthAdapter, cfg)).toThrow(
      /getM2MClient/,
    );
  });

  test('all missing-method errors are collected into a single throw', () => {
    // Enable multiple features simultaneously, each requiring methods the adapter lacks
    const cfg: AdapterValidationConfig = {
      ...MINIMAL_CFG,
      hasOAuthProviders: true,
      hasMfa: true,
      hasSuspension: true,
    };

    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter() as AuthAdapter, cfg);
    } catch (err: unknown) {
      message = (err as Error).message;
    }

    // All three feature sets should appear in the single error message
    expect(message).toContain('findOrCreateByProvider');
    expect(message).toContain('setMfaSecret');
    expect(message).toContain('setSuspended');
  });
});
