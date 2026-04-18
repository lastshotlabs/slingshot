// validateAdapterCapabilities checks that the active AuthAdapter implements
// all methods required by the features configured in CreateAppConfig.
// Collects all missing-method errors before throwing so the developer sees
// everything that needs fixing in one pass.
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

/**
 * Feature-flag snapshot used to drive `validateAdapterCapabilities`.
 *
 * Each boolean corresponds to one or more enabled features that require specific methods
 * on the `AuthAdapter`. This snapshot is computed once during bootstrap from the resolved
 * `AuthPluginConfig` and passed to `validateAdapterCapabilities` at startup.
 *
 * @remarks
 * Exposed publicly so consumers who build custom bootstrap flows (outside `createAuthPlugin`)
 * can construct and pass this config directly to `validateAdapterCapabilities`.
 */
export interface AdapterValidationConfig {
  // Feature flags
  hasOAuthProviders: boolean;
  hasMfa: boolean;
  hasMfaWebAuthn: boolean;
  hasRoles: boolean; // auth.roles, auth.defaultRole, or tenancy configured
  hasDefaultRole: boolean; // auth.defaultRole specifically (for targeted error message compat)
  hasGroups: boolean;
  hasSuspension: boolean; // auth.checkSuspensionOnIdentify or adminApi.enabled
  hasM2m: boolean;
  hasAdminApi: boolean;
  hasPasswordReset: boolean;
  hasPreventReuse: boolean;
  hasScim: boolean;
  scimDeprovisionMode?: 'suspend' | 'delete' | 'custom';
}

/**
 * Validates that the configured `AuthAdapter` implements all methods required by the
 * enabled feature set. Collects every missing-method error before throwing so
 * developers see the complete list in a single startup failure.
 *
 * Called automatically by `bootstrapAuth` and not normally called directly by consumers.
 *
 * @param adapter - The `AuthAdapter` instance to validate.
 * @param cfg - Feature flags derived from the resolved `AuthPluginConfig`.
 *
 * @throws {Error} When one or more required adapter methods are missing. The error message
 *   lists every missing method with a human-readable explanation.
 *
 * @example
 * validateAdapterCapabilities(myAdapter, {
 *   hasOAuthProviders: true,
 *   hasMfa: false,
 *   hasMfaWebAuthn: false,
 *   hasRoles: true,
 *   hasDefaultRole: true,
 *   hasGroups: false,
 *   hasSuspension: false,
 *   hasM2m: false,
 *   hasAdminApi: false,
 *   hasPasswordReset: true,
 *   hasPreventReuse: false,
 *   hasScim: false,
 *   scimDeprovisionMode: 'suspend',
 * });
 */
export function validateAdapterCapabilities(
  adapter: AuthAdapter,
  cfg: AdapterValidationConfig,
): void {
  const errors: string[] = [];

  // ---------------------------------------------------------------------------
  // Core - always required
  // ---------------------------------------------------------------------------
  const coreMethods = ['verifyPassword', 'getIdentifier'] as const;
  for (const method of coreMethods) {
    if (typeof adapter[method] !== 'function') {
      errors.push(`the auth adapter does not implement ${method}. Add ${method} to your adapter.`);
    }
  }

  // ---------------------------------------------------------------------------
  // passwordReset - requires setPassword
  // ---------------------------------------------------------------------------
  if (cfg.hasPasswordReset && !adapter.setPassword) {
    errors.push(
      '"passwordReset" is configured but the auth adapter does not implement setPassword. Add setPassword to your adapter or remove passwordReset.',
    );
  }

  // ---------------------------------------------------------------------------
  // Tier 2 - OAuth
  // ---------------------------------------------------------------------------
  if (cfg.hasOAuthProviders) {
    const oauthMethods = ['findOrCreateByProvider', 'linkProvider', 'unlinkProvider'] as const;
    for (const method of oauthMethods) {
      if (!adapter[method]) {
        errors.push(
          `"oauth.providers" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 3 - MFA
  // ---------------------------------------------------------------------------
  if (cfg.hasMfa) {
    const mfaMethods = [
      'setMfaSecret',
      'getMfaSecret',
      'isMfaEnabled',
      'setMfaEnabled',
      'setRecoveryCodes',
      'getRecoveryCodes',
      'removeRecoveryCode',
      'consumeRecoveryCode',
    ] as const;
    for (const method of mfaMethods) {
      if (!adapter[method]) {
        errors.push(
          `"mfa" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 4 - WebAuthn
  // ---------------------------------------------------------------------------
  if (cfg.hasMfaWebAuthn) {
    const webauthnMethods = [
      'getWebAuthnCredentials',
      'addWebAuthnCredential',
      'removeWebAuthnCredential',
      'updateWebAuthnCredentialSignCount',
      'findUserByWebAuthnCredentialId',
    ] as const;
    for (const method of webauthnMethods) {
      if (!adapter[method]) {
        errors.push(
          `"mfa.webauthn" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 5 - Roles
  // ---------------------------------------------------------------------------
  if (cfg.hasRoles || cfg.hasDefaultRole) {
    const roleMethods = ['getRoles', 'setRoles', 'addRole', 'removeRole'] as const;
    for (const method of roleMethods) {
      if (!adapter[method]) {
        if (cfg.hasDefaultRole && method === 'setRoles') {
          errors.push(
            `"defaultRole" is set but the auth adapter does not implement setRoles. Add setRoles to your adapter or remove defaultRole.`,
          );
        } else {
          errors.push(
            `roles are configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 6 - Groups
  // ---------------------------------------------------------------------------
  if (cfg.hasGroups) {
    const groupMethods = [
      'createGroup',
      'deleteGroup',
      'getGroup',
      'listGroups',
      'updateGroup',
      'addGroupMember',
      'updateGroupMembership',
      'removeGroupMember',
      'getGroupMembers',
      'getUserGroups',
      'getEffectiveRoles',
    ] as const;
    for (const method of groupMethods) {
      if (!adapter[method]) {
        errors.push(
          `"groups" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 7 - Suspension
  // ---------------------------------------------------------------------------
  if (cfg.hasSuspension) {
    const suspensionMethods = ['setSuspended', 'getSuspended'] as const;
    for (const method of suspensionMethods) {
      if (!adapter[method]) {
        errors.push(
          `suspension checking is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 8 - Enterprise: M2M
  // ---------------------------------------------------------------------------
  if (cfg.hasM2m) {
    const m2mMethods = [
      'getM2MClient',
      'createM2MClient',
      'deleteM2MClient',
      'listM2MClients',
    ] as const;
    for (const method of m2mMethods) {
      if (!adapter[method]) {
        errors.push(
          `"auth.m2m" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 8 - Enterprise: admin.api requires listUsers
  // ---------------------------------------------------------------------------
  if (cfg.hasAdminApi && !adapter.listUsers) {
    errors.push(
      `"adminApi" is configured but the auth adapter does not implement listUsers. Add listUsers to your adapter.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Tier 8 - Enterprise: password history (preventReuse)
  // ---------------------------------------------------------------------------
  if (cfg.hasPreventReuse) {
    const historyMethods = ['getPasswordHistory', 'addPasswordToHistory'] as const;
    for (const method of historyMethods) {
      if (!adapter[method]) {
        errors.push(
          `"auth.passwordPolicy.preventReuse" is configured but the auth adapter does not implement ${method}. Add ${method} to your adapter.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SCIM - requires fail-closed deprovision support
  // ---------------------------------------------------------------------------
  if (cfg.hasScim) {
    if (!adapter.getUser) {
      errors.push(
        '"scim" is enabled but the auth adapter does not implement getUser. ' +
          'SCIM DELETE requires getUser to return 404 for non-existent resources (RFC 7644 §3.6). ' +
          'Add getUser to your adapter or disable SCIM.',
      );
    }

    const deprovisionMode = cfg.scimDeprovisionMode ?? 'suspend';
    if (deprovisionMode === 'suspend' && !adapter.setSuspended) {
      errors.push(
        '"scim" deprovisioning is configured for "suspend" but the auth adapter does not implement setSuspended. ' +
          'Add setSuspended to your adapter, switch SCIM deprovisioning to "delete", or provide a custom onDeprovision handler.',
      );
    }
    if (deprovisionMode === 'delete' && !adapter.deleteUser) {
      errors.push(
        '"scim" deprovisioning is configured for "delete" but the auth adapter does not implement deleteUser. ' +
          'Add deleteUser to your adapter, switch SCIM deprovisioning to "suspend", or provide a custom onDeprovision handler.',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `createApp: Adapter capability validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
    );
  }
}
