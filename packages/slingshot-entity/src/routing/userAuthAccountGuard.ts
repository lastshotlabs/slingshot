import type { Context } from 'hono';
import { getActor, type AppEnv, type AuthRuntimePeer } from '@lastshotlabs/slingshot-core';
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
 * Entity routes can be mounted in apps that disable identify-time suspension
 * checks. When auth runtime state is available, fail closed on stale sessions
 * before the route handler runs. If auth is not installed, treat this as a
 * no-op so entity-only usage remains decoupled from slingshot-auth.
 */
export async function getUserAuthAccountGuardFailure(
  c: Context<AppEnv, string>,
): Promise<AccountGuardFailure | null> {
  const actor = getActor(c);
  if (actor.kind !== 'user' || !actor.id) {
    throw new Error(
      '[security] entity userAuth account guard requires an authenticated user actor',
    );
  }

  const runtime = getAuthRuntime(c);
  if (!runtime?.adapter) {
    return null;
  }

  const suspensionStatus = runtime.adapter.getSuspended
    ? ((await runtime.adapter.getSuspended(actor.id)) ?? { suspended: false })
    : { suspended: false };
  if (suspensionStatus.suspended) {
    return { error: 'Account suspended', status: 403 };
  }

  const requiresVerifiedEmail =
    runtime.config?.primaryField === 'email' && runtime.config.emailVerification?.required === true;
  if (!requiresVerifiedEmail || !runtime.adapter.getEmailVerified) {
    return null;
  }

  const verified = await runtime.adapter.getEmailVerified(actor.id);
  if (!verified) {
    return { error: 'Email not verified', status: 403 };
  }

  return null;
}
