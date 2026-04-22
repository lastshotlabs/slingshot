/**
 * Host-only guard middleware.
 *
 * Rejects requests from non-host users on REST routes.
 * Captures the session adapter via closure (Rule 3).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { GameErrorCode } from '../errors';

interface HostOnlyGuardDeps {
  /** Resolved session adapter — set during buildAdapter callback. */
  getSessionAdapter: () => { getById(id: string): Promise<Record<string, unknown> | null> };
}

/**
 * Build the host-only guard middleware.
 *
 * Registered under `'hostOnlyGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildHostOnlyGuard({ getSessionAdapter }: HostOnlyGuardDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    const sessionId = c.req.param('id');
    const userId = getActorId(c) ?? undefined;

    if (!sessionId || !userId) {
      throw new HTTPException(400, { message: 'Missing session ID or auth.' });
    }

    const adapter = getSessionAdapter();
    const session = await adapter.getById(sessionId);

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    if (session.hostUserId !== userId) {
      throw new HTTPException(403, {
        message: `Only the host can perform this action. Code: ${GameErrorCode.HOST_ONLY}`,
      });
    }

    await next();
  };
}
