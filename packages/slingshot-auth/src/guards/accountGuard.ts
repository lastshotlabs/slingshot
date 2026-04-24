import type {
  AuthAdapter,
  PostAuthGuard,
  PostAuthGuardFailure,
} from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';

interface AccountGuardDeps {
  adapter: AuthAdapter;
  config: {
    primaryField: string;
    emailVerification: { required?: boolean } | null;
  };
}

/**
 * Create a post-auth guard that checks account suspension and email
 * verification status.
 *
 * Registered on the `RouteAuthRegistry.postGuards` array by the auth plugin
 * so entity, package, and framework routes enforce these checks generically
 * without importing auth internals.
 */
export function createAccountGuard(deps: AccountGuardDeps): PostAuthGuard {
  return async (c): Promise<PostAuthGuardFailure | null> => {
    const actor = getActor(c);
    if (actor.kind !== 'user' || !actor.id) {
      return null;
    }

    const { adapter, config } = deps;

    if (adapter.getSuspended) {
      const suspensionStatus = (await adapter.getSuspended(actor.id)) ?? { suspended: false };
      if (suspensionStatus.suspended) {
        return { error: 'ACCOUNT_SUSPENDED', message: 'Account is suspended', status: 403 };
      }
    }

    const requiresVerifiedEmail =
      config.primaryField === 'email' && config.emailVerification?.required === true;
    if (!requiresVerifiedEmail || !adapter.getEmailVerified) {
      return null;
    }

    const verified = await adapter.getEmailVerified(actor.id);
    if (!verified) {
      return { error: 'EMAIL_NOT_VERIFIED', message: 'Email not verified', status: 403 };
    }

    return null;
  };
}
