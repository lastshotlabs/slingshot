import { getAuthRuntimeFromRequest } from '@lastshotlabs/slingshot-auth';
import { assertLoginEmailVerified, getSuspended } from '@lastshotlabs/slingshot-auth/plugin';
import { HttpError } from '@lastshotlabs/slingshot-core';

/**
 * Resolve whether a request authenticated via `userAuth` should be blocked
 * because the account became suspended or fell out of a required
 * email-verification policy after the session was issued.
 *
 * Framework-owned routes that expose sensitive read or write capability should
 * call this after `userAuth` so stale sessions fail closed even when
 * `auth.checkSuspensionOnIdentify` is explicitly disabled.
 */
export async function getAuthenticatedAccountGuardFailure(c: {
  get(key: string): unknown;
}): Promise<{ error: 'Account suspended' | 'Email not verified'; status: 403 } | null> {
  const userId = c.get('authUserId');
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(
      '[security] authenticated route guard requires an authenticated authUserId context',
    );
  }

  const runtime = getAuthRuntimeFromRequest(c);
  const suspensionStatus = await getSuspended(runtime.adapter, userId);
  if (suspensionStatus.suspended) {
    return { error: 'Account suspended', status: 403 };
  }

  try {
    await assertLoginEmailVerified(userId, runtime);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      return { error: 'Email not verified', status: 403 };
    }
    throw err;
  }

  return null;
}
