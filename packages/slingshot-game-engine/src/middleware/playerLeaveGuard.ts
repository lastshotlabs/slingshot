/**
 * Player leave guard middleware.
 *
 * Handles host transfer when the host leaves during lobby,
 * and player cleanup on leave.
 *
 * Captures session/player adapters via closure (Rule 3).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { listAdapterRecords } from '../lib/adapterQuery';

interface PlayerLeaveGuardDeps {
  getSessionAdapter: () => {
    getById(id: string): Promise<Record<string, unknown> | null>;
    update(id: string, data: Record<string, unknown>): Promise<unknown>;
  };
  getPlayerAdapter: () => {
    find?: (filter: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    list?: (filter: Record<string, unknown>) => Promise<unknown>;
    update(id: string, data: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Build the player leave guard middleware.
 *
 * Registered under `'playerLeaveGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildPlayerLeaveGuard({
  getSessionAdapter,
  getPlayerAdapter,
}: PlayerLeaveGuardDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    const sessionId = c.req.param('id') ?? c.req.param('sessionId');
    const targetUserId = c.req.param('userId') ?? (getActorId(c) ?? undefined);

    if (!sessionId || !targetUserId) {
      throw new HTTPException(400, { message: 'Missing session or user ID.' });
    }

    const sessionAdapter = getSessionAdapter();
    const session = await sessionAdapter.getById(sessionId);

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    const playerAdapter = getPlayerAdapter();
    const players = await listAdapterRecords(playerAdapter, { sessionId });
    const leavingPlayer = players.find(p => p.userId === targetUserId);

    if (!leavingPlayer) {
      throw new HTTPException(404, { message: 'Player not found in session.' });
    }

    // Host transfer if the leaving player is host and session is in lobby
    if (leavingPlayer.isHost && session.status === 'lobby') {
      const remainingPlayers = players
        .filter(p => p.userId !== targetUserId && !(p.isSpectator as boolean))
        .sort((a, b) => (a.joinOrder as number) - (b.joinOrder as number));

      if (remainingPlayers.length > 0) {
        const newHost = remainingPlayers[0];
        await playerAdapter.update(newHost.id as string, { isHost: true });
        await sessionAdapter.update(sessionId, {
          hostUserId: newHost.userId as string,
        });
      }
    }

    await next();
  };
}
