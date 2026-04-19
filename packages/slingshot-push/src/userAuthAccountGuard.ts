import type { Context } from 'hono';
import type { AppEnv, AuthRuntimePeer } from '@lastshotlabs/slingshot-core';
import {
  getAuthRuntimePeerOrNull,
  getPluginStateFromRequestOrNull,
} from '@lastshotlabs/slingshot-core';

type AccountGuardFailure = {
  error: 'Account suspended' | 'Email not verified';
  status: 403;
};

type AuthAdapterLike = {
  getSuspended?: (
    userId: string,
  ) => Promise<{ suspended: boolean; suspendedReason?: string } | null>;
  getEmailVerified?: (userId: string) => Promise<boolean | null | undefined>;
};

type AuthRuntimeLike = AuthRuntimePeer & {
  adapter: AuthAdapterLike;
  config?: {
    primaryField?: string;
    emailVerification?: {
      required?: boolean;
    } | null;
  };
};

function getAuthRuntime(c: Context<AppEnv, string>): AuthRuntimeLike | null {
  const runtime = getAuthRuntimePeerOrNull(getPluginStateFromRequestOrNull(c));
  if (!runtime) {
    return null;
  }
  return runtime as AuthRuntimeLike;
}

/**
 * Re-check suspension and required email verification after `userAuth`.
 *
 * Push topic mutation and delivery-ack routes are session-bound and should fail
 * closed for stale sessions. If auth runtime state is unavailable, leave the
 * request unchanged so plugin tests and custom route-auth harnesses remain
 * decoupled from full auth bootstrap.
 */
export async function getUserAuthAccountGuardFailure(
  c: Context<AppEnv, string>,
): Promise<AccountGuardFailure | null> {
  const userId = c.get('authUserId' as never) as unknown;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(
      '[security] push userAuth account guard requires an authenticated authUserId context',
    );
  }

  const runtime = getAuthRuntime(c);
  if (!runtime?.adapter) {
    return null;
  }

  const suspensionStatus = runtime.adapter.getSuspended
    ? ((await runtime.adapter.getSuspended(userId)) ?? { suspended: false })
    : { suspended: false };
  if (suspensionStatus.suspended) {
    return { error: 'Account suspended', status: 403 };
  }

  const requiresVerifiedEmail =
    runtime.config?.primaryField === 'email' && runtime.config.emailVerification?.required === true;
  if (!requiresVerifiedEmail || !runtime.adapter.getEmailVerified) {
    return null;
  }

  const verified = await runtime.adapter.getEmailVerified(userId);
  if (!verified) {
    return { error: 'Email not verified', status: 403 };
  }

  return null;
}
