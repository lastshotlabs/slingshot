import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

/**
 * Stable plugin-state key published by `slingshot-auth`.
 *
 * Packages that need only a narrow auth-facing peer contract should depend on
 * this key and the accessors below instead of spelunking for raw string keys.
 */
export const AUTH_PLUGIN_STATE_KEY = 'slingshot-auth' as const;

/**
 * Request metadata passed into auth-controlled account access decisions.
 */
export interface AuthUserAccessInput {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly ip?: string | null;
  readonly method?: string;
  readonly path?: string;
  readonly userAgent?: string | null;
}

/**
 * Normalized result returned by auth-controlled account access decisions.
 */
export interface AuthUserAccessDecision {
  readonly allow: boolean;
  readonly status?: 403;
  readonly message?: string;
  readonly code?: string;
  readonly reason?: string;
}

type AuthAccessAdapterLike = {
  getSuspended?: (
    userId: string,
  ) => Promise<{ suspended: boolean; suspendedReason?: string } | null>;
  getEmailVerified?: (userId: string) => Promise<boolean | null | undefined>;
};

/**
 * Minimal peer-facing auth runtime shape shared through `ctx.pluginState`.
 *
 * This intentionally models only the cross-package surface needed by packages
 * that coordinate with auth without importing `@lastshotlabs/slingshot-auth`.
 */
export interface AuthRuntimePeer {
  readonly adapter: object;
  readonly config?: {
    readonly primaryField?: string;
    readonly emailVerification?: {
      readonly required?: boolean;
    } | null;
  } | null;
  /**
   * Optional hook for application-specific account-state checks that run after
   * the built-in suspension and required-email-verification policy.
   */
  readonly evaluateUserAccess?: (
    input: AuthUserAccessInput,
  ) => Promise<AuthUserAccessDecision | boolean | void>;
}

/**
 * Retrieve the auth runtime peer from plugin state.
 */
export function getAuthRuntimePeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): AuthRuntimePeer {
  const runtime = getAuthRuntimePeerOrNull(input);
  if (!runtime) {
    throw new Error('[slingshot-auth] auth runtime peer is not available in pluginState');
  }
  return runtime;
}

/**
 * Retrieve the auth runtime peer from plugin state when auth has published it.
 */
export function getAuthRuntimePeerOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): AuthRuntimePeer | null {
  const pluginState = getPluginStateOrNull(input);
  const runtime = pluginState?.get(AUTH_PLUGIN_STATE_KEY);
  if (typeof runtime !== 'object' || runtime === null) {
    return null;
  }

  const adapter = Reflect.get(runtime, 'adapter');
  if (typeof adapter !== 'object' || adapter === null) {
    return null;
  }

  return runtime as AuthRuntimePeer;
}

function deny(
  message: string,
  opts?: Pick<AuthUserAccessDecision, 'code' | 'reason' | 'status'>,
): AuthUserAccessDecision {
  return {
    allow: false,
    status: opts?.status ?? 403,
    message,
    code: opts?.code,
    reason: opts?.reason,
  };
}

function normalizeDecision(
  decision: AuthUserAccessDecision | boolean | void,
): AuthUserAccessDecision {
  if (decision === undefined || decision === true) {
    return { allow: true };
  }
  if (decision === false) {
    return deny('Account access denied', {
      code: 'account_access_denied',
      reason: 'account_access_denied',
    });
  }
  if (decision.allow) {
    return { allow: true };
  }
  return {
    allow: false,
    status: decision.status ?? 403,
    message: decision.message ?? 'Account access denied',
    code: decision.code,
    reason: decision.reason,
  };
}

/**
 * Evaluate the effective authenticated-user access policy exposed by auth.
 *
 * Built-in checks remain the default baseline:
 * - suspended accounts are denied
 * - required email verification is enforced for email-primary apps
 *
 * When auth publishes `evaluateUserAccess`, that user-defined policy runs after
 * the built-ins and can impose additional restrictions without teaching core
 * about application-specific account-state fields.
 */
export async function evaluateAuthUserAccess(
  runtime: AuthRuntimePeer,
  input: AuthUserAccessInput,
): Promise<AuthUserAccessDecision> {
  const adapter = runtime.adapter as AuthAccessAdapterLike;

  const suspensionStatus = adapter.getSuspended
    ? ((await adapter.getSuspended(input.userId)) ?? { suspended: false })
    : { suspended: false };
  if (suspensionStatus.suspended) {
    return deny('Account suspended', {
      code: 'account_suspended',
      reason: 'account_suspended',
    });
  }

  const requiresVerifiedEmail =
    runtime.config?.primaryField === 'email' && runtime.config.emailVerification?.required === true;
  if (requiresVerifiedEmail && adapter.getEmailVerified) {
    const verified = await adapter.getEmailVerified(input.userId);
    if (!verified) {
      return deny('Email not verified', {
        code: 'email_not_verified',
        reason: 'email_not_verified',
      });
    }
  }

  return normalizeDecision(await runtime.evaluateUserAccess?.(input));
}
