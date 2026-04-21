import { getAuthRuntimeFromRequest } from '@lastshotlabs/slingshot-auth';
import { evaluateAuthUserAccess, getActor } from '@lastshotlabs/slingshot-core';

function readString(c: { get(key: string): unknown }, key: string): string | null {
  const value = c.get(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRequestInfo(c: {
  req?: {
    method?: string;
    path?: string;
    header?(name: string): string | undefined;
  };
}) {
  const request = c.req;
  return {
    method: typeof request?.method === 'string' ? request.method : undefined,
    path: typeof request?.path === 'string' ? request.path : undefined,
    userAgent: request?.header?.('user-agent') ?? null,
  };
}

/**
 * Resolve whether a request authenticated via `userAuth` should be blocked
 * because the account became suspended, fell out of a required
 * email-verification policy, or is denied by the auth account-access hook
 * after the session was issued.
 *
 * Framework-owned routes that expose sensitive read or write capability should
 * call this after `userAuth` so stale sessions fail closed even when
 * `auth.checkSuspensionOnIdentify` is explicitly disabled.
 */
export async function getAuthenticatedAccountGuardFailure(c: {
  get(key: string): unknown;
  req?: {
    method?: string;
    path?: string;
    header?(name: string): string | undefined;
  };
}): Promise<{ error: string; status: 403 } | null> {
  const actor = getActor(c as Parameters<typeof getActor>[0]);
  if (actor.kind !== 'user' || !actor.id) {
    throw new Error(
      '[security] authenticated route guard requires an authenticated user actor',
    );
  }

  const runtime = getAuthRuntimeFromRequest(c);
  const requestInfo = readRequestInfo(c);
  const decision = await evaluateAuthUserAccess(runtime, {
    userId: actor.id,
    tenantId: actor.tenantId,
    requestId: readString(c, 'requestId') ?? undefined,
    correlationId: readString(c, 'correlationId') ?? undefined,
    ip: readString(c, 'clientIp'),
    method: requestInfo.method,
    path: requestInfo.path,
    userAgent: requestInfo.userAgent,
  });
  if (!decision.allow) {
    return { error: decision.message ?? 'Account access denied', status: 403 };
  }

  return null;
}
