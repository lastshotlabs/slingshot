/**
 * Player join guard middleware.
 *
 * Validates session capacity, session status, and duplicate check
 * before a player entity is created.
 *
 * Captures session/player adapters via closure (Rule 3).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { GameError, GameErrorCode } from '../errors';
import { listAdapterRecords } from '../lib/adapterQuery';
import type { GameDefinition } from '../types/models';

interface PlayerJoinGuardDeps {
  getSessionAdapter: () => {
    getById(id: string): Promise<Record<string, unknown> | null>;
  };
  getPlayerAdapter: () => {
    find?: (filter: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    list?: (filter: Record<string, unknown>) => Promise<unknown>;
  };
  getRegistry: () => ReadonlyMap<string, GameDefinition>;
}

/**
 * Build the player join guard middleware.
 *
 * Registered under `'playerJoinGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildPlayerJoinGuard({
  getSessionAdapter,
  getPlayerAdapter,
  getRegistry,
}: PlayerJoinGuardDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    const sessionId = c.req.param('id');
    const userId = getActorId(c) ?? undefined;

    if (!sessionId || !userId) {
      throw new HTTPException(400, { message: 'Missing session ID or auth.' });
    }

    const sessionAdapter = getSessionAdapter();
    const session = await sessionAdapter.getById(sessionId);

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    if (session.status !== 'lobby') {
      throw new GameError(
        GameErrorCode.SESSION_NOT_IN_LOBBY,
        'Can only join sessions in lobby status.',
        { httpStatus: 409, sessionId },
      );
    }

    // Check for duplicate
    const playerAdapter = getPlayerAdapter();
    const existing = await listAdapterRecords(playerAdapter, { sessionId, userId });
    if (existing.length > 0) {
      throw new GameError(
        GameErrorCode.PLAYER_ALREADY_IN_SESSION,
        'Player is already in this session.',
        { httpStatus: 409, sessionId },
      );
    }

    // Check capacity
    const gameType = session.gameType as string;
    const registry = getRegistry();
    const gameDef = registry.get(gameType);

    if (gameDef) {
      const allPlayers = await listAdapterRecords(playerAdapter, { sessionId });
      const activePlayers = allPlayers.filter(p => !(p.isSpectator as boolean));

      if (activePlayers.length >= gameDef.maxPlayers) {
        // Try as spectator if allowed
        if (!gameDef.allowSpectators) {
          throw new GameError(GameErrorCode.SESSION_FULL, 'Session is full.', {
            httpStatus: 409,
            sessionId,
          });
        }

        const spectators = allPlayers.filter(p => p.isSpectator as boolean);
        if (spectators.length >= gameDef.maxSpectators) {
          throw new GameError(GameErrorCode.SESSION_SPECTATORS_FULL, 'Spectator slots are full.', {
            httpStatus: 409,
            sessionId,
          });
        }

        // Auto-assign as spectator
        const spectatorBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        spectatorBody.isSpectator = true;
      }
    }

    // Inject join metadata
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    body.sessionId = sessionId;
    body.userId = userId;

    // Compute join order
    const allPlayers = await listAdapterRecords(playerAdapter, { sessionId });
    body.joinOrder = allPlayers.length;

    await next();
  };
}
