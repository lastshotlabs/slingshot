import type { MiddlewareHandler } from 'hono';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { RoomMemberAdapter } from '../types';

/** Reject message creation while the actor's room membership is timed out. */
export function createTimeoutGuardMiddleware(deps: {
  memberAdapter: RoomMemberAdapter;
  now?: () => number;
}): MiddlewareHandler {
  const now = deps.now ?? Date.now;
  return async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { roomId?: string } | null;
    const roomId = body?.roomId;
    const actorId = getActorId(c);
    if (!roomId || !actorId) return next();

    const member = await deps.memberAdapter.findMember({ roomId, userId: actorId });
    const mutedUntil = member?.mutedUntil ? new Date(member.mutedUntil).getTime() : 0;
    const remaining = Math.ceil((mutedUntil - now()) / 1000);
    if (remaining <= 0) return next();

    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, '0');
    return c.json(
      { error: `YOU'RE BENCHED — ${minutes}:${seconds}`, code: 'ROOM_MEMBER_TIMEOUT', remainingSeconds: remaining },
      429,
      { 'Retry-After': String(remaining) },
    );
  };
}
