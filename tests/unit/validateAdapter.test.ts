import { validateAdapterCapabilities } from '@auth/lib/validateAdapter';
import type { AdapterValidationConfig } from '@auth/lib/validateAdapter';
import { describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Minimal adapter that satisfies core requirements
// ---------------------------------------------------------------------------

const coreAdapter: AuthAdapter = {
  findByEmail: async () => null,
  create: async () => ({ id: '1' }),
  verifyPassword: async () => false,
  getIdentifier: async () => 'user@example.com',
  consumeRecoveryCode: async () => false,
};

const noFeatures: AdapterValidationConfig = {
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
  scimDeprovisionMode: 'suspend',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateAdapterCapabilities', () => {
  // 1. No error when adapter has all required methods for configured features
  test('no error when core adapter with no optional features configured', () => {
    expect(() => {
      validateAdapterCapabilities(coreAdapter, noFeatures);
    }).not.toThrow();
  });

  // 2. Error thrown when MFA configured but adapter missing MfaAdapter methods — lists ALL missing
  test('throws with all missing MFA methods when mfa configured', () => {
    const adapterWithoutMfa: AuthAdapter = { ...coreAdapter };

    let threw = false;
    let message = '';
    try {
      validateAdapterCapabilities(adapterWithoutMfa, { ...noFeatures, hasMfa: true });
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }

    expect(threw).toBe(true);
    // Should list all required MFA methods
    expect(message).toContain('setMfaSecret');
    expect(message).toContain('getMfaSecret');
    expect(message).toContain('isMfaEnabled');
    expect(message).toContain('setMfaEnabled');
    expect(message).toContain('setRecoveryCodes');
    expect(message).toContain('getRecoveryCodes');
    expect(message).toContain('removeRecoveryCode');
    // consumeRecoveryCode is in CoreAuthAdapter (required always), handled separately
  });

  test('no error when MFA configured and adapter has all MFA methods', () => {
    const mfaAdapter: AuthAdapter = {
      ...coreAdapter,
      setMfaSecret: async () => {},
      getMfaSecret: async () => null,
      isMfaEnabled: async () => false,
      setMfaEnabled: async () => {},
      setRecoveryCodes: async () => {},
      getRecoveryCodes: async () => [],
      removeRecoveryCode: async () => {},
    };

    expect(() => {
      validateAdapterCapabilities(mfaAdapter, { ...noFeatures, hasMfa: true });
    }).not.toThrow();
  });

  // 3. Error thrown when OAuth configured but adapter missing OAuthAdapter methods
  test('throws with missing OAuth methods when oauth providers configured', () => {
    let threw = false;
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, { ...noFeatures, hasOAuthProviders: true });
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }

    expect(threw).toBe(true);
    expect(message).toContain('findOrCreateByProvider');
    expect(message).toContain('linkProvider');
    expect(message).toContain('unlinkProvider');
  });

  test('no error when OAuth configured and adapter has all OAuth methods', () => {
    const oauthAdapter: AuthAdapter = {
      ...coreAdapter,
      findOrCreateByProvider: async () => ({ id: '1', created: false }),
      linkProvider: async () => {},
      unlinkProvider: async () => {},
    };

    expect(() => {
      validateAdapterCapabilities(oauthAdapter, { ...noFeatures, hasOAuthProviders: true });
    }).not.toThrow();
  });

  // 4. Multiple missing features → single combined error with all missing methods
  test('collects errors from multiple missing features before throwing', () => {
    let threw = false;
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, {
        ...noFeatures,
        hasOAuthProviders: true,
        hasMfa: true,
        hasGroups: true,
      });
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }

    expect(threw).toBe(true);
    // OAuth errors
    expect(message).toContain('findOrCreateByProvider');
    // MFA errors
    expect(message).toContain('setMfaSecret');
    // Groups errors
    expect(message).toContain('createGroup');
    expect(message).toContain('getEffectiveRoles');
    // All errors are in one message (not just the first)
    const bulletCount = (message.match(/^  -/gm) ?? []).length;
    expect(bulletCount).toBeGreaterThan(5);
  });

  // 5. defaultRole check preserves backward-compat error message
  test('throws with defaultRole-specific message when defaultRole set but setRoles missing', () => {
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, { ...noFeatures, hasDefaultRole: true });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toMatch(/defaultRole.*setRoles/i);
  });

  // 6. Core verifyPassword missing
  test('throws when verifyPassword is missing', () => {
    const adapterMissingVerify = {
      findByEmail: async () => null,
      create: async () => ({ id: '1' }),
      getIdentifier: async () => 'user@example.com',
      consumeRecoveryCode: async () => false,
    } as unknown as AuthAdapter;

    expect(() => {
      validateAdapterCapabilities(adapterMissingVerify, noFeatures);
    }).toThrow(/verifyPassword/);
  });

  // 7. Core getIdentifier missing
  test('throws when getIdentifier is missing', () => {
    const adapterMissingIdentifier = {
      findByEmail: async () => null,
      create: async () => ({ id: '1' }),
      verifyPassword: async () => false,
      consumeRecoveryCode: async () => false,
    } as unknown as AuthAdapter;

    expect(() => {
      validateAdapterCapabilities(adapterMissingIdentifier, noFeatures);
    }).toThrow(/getIdentifier/);
  });

  // 8. passwordReset requires setPassword
  test('throws when passwordReset configured but setPassword missing', () => {
    expect(() => {
      validateAdapterCapabilities(coreAdapter, { ...noFeatures, hasPasswordReset: true });
    }).toThrow(/passwordReset.*setPassword/i);
  });

  test('no error when passwordReset configured and adapter has setPassword', () => {
    const adapterWithSetPassword: AuthAdapter = {
      ...coreAdapter,
      setPassword: async () => {},
    };

    expect(() => {
      validateAdapterCapabilities(adapterWithSetPassword, {
        ...noFeatures,
        hasPasswordReset: true,
      });
    }).not.toThrow();
  });

  // 9. suspension checks
  test('throws when suspension configured but setSuspended/getSuspended missing', () => {
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, { ...noFeatures, hasSuspension: true });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain('setSuspended');
    expect(message).toContain('getSuspended');
  });

  // 10. preventReuse requires getPasswordHistory + addPasswordToHistory
  test('throws when preventReuse configured but history methods missing', () => {
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, { ...noFeatures, hasPreventReuse: true });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain('getPasswordHistory');
    expect(message).toContain('addPasswordToHistory');
  });

  test('throws when SCIM suspend deprovisioning is configured but setSuspended is missing', () => {
    let message = '';
    try {
      validateAdapterCapabilities(coreAdapter, {
        ...noFeatures,
        hasScim: true,
        scimDeprovisionMode: 'suspend',
      });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain('getUser');
    expect(message).toContain('setSuspended');
  });

  test('throws when SCIM delete deprovisioning is configured but deleteUser is missing', () => {
    const adapterWithGetUser: AuthAdapter = {
      ...coreAdapter,
      getUser: async () => null,
    };

    expect(() => {
      validateAdapterCapabilities(adapterWithGetUser, {
        ...noFeatures,
        hasScim: true,
        scimDeprovisionMode: 'delete',
      });
    }).toThrow(/deleteUser/);
  });

  test('no error when SCIM suspend deprovisioning has required adapter methods', () => {
    const scimSuspendAdapter: AuthAdapter = {
      ...coreAdapter,
      getUser: async () => null,
      setSuspended: async () => {},
    };

    expect(() => {
      validateAdapterCapabilities(scimSuspendAdapter, {
        ...noFeatures,
        hasScim: true,
        scimDeprovisionMode: 'suspend',
      });
    }).not.toThrow();
  });

  test('no error when SCIM delete deprovisioning has required adapter methods', () => {
    const scimDeleteAdapter: AuthAdapter = {
      ...coreAdapter,
      getUser: async () => null,
      deleteUser: async () => {},
    };

    expect(() => {
      validateAdapterCapabilities(scimDeleteAdapter, {
        ...noFeatures,
        hasScim: true,
        scimDeprovisionMode: 'delete',
      });
    }).not.toThrow();
  });
});
