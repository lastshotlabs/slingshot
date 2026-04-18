/**
 * Start game guard middleware.
 *
 * Validates min players, loads content, and prepares game state
 * before the `startGame` transition fires.
 *
 * Captures session/player adapters and game registry via closure (Rule 3).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GameError, GameErrorCode } from '../errors';
import { listAdapterRecords } from '../lib/adapterQuery';
import type { GameDefinition } from '../types/models';

interface StartGameGuardDeps {
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
 * Build the start game guard middleware.
 *
 * Registered under `'startGameGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildStartGameGuard({
  getSessionAdapter,
  getPlayerAdapter,
  getRegistry,
}: StartGameGuardDeps) {
  return async (c: Context, next: Next) => {
    const sessionId = c.req.param('id');
    if (!sessionId) {
      throw new HTTPException(400, { message: 'Missing session ID.' });
    }

    const sessionAdapter = getSessionAdapter();
    const session = await sessionAdapter.getById(sessionId);
    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    const gameType = session.gameType as string;
    const registry = getRegistry();
    const gameDef = registry.get(gameType);
    if (!gameDef) {
      throw new GameError(GameErrorCode.GAME_TYPE_NOT_FOUND, `Game type '${gameType}' not found.`, {
        httpStatus: 404,
        sessionId,
      });
    }

    // Validate player count
    const playerAdapter = getPlayerAdapter();
    const players = await listAdapterRecords(playerAdapter, { sessionId });
    const activePlayers = players.filter(p => !(p.isSpectator as boolean));

    if (activePlayers.length < gameDef.minPlayers) {
      throw new GameError(
        GameErrorCode.INSUFFICIENT_PLAYERS,
        `Need at least ${gameDef.minPlayers} players to start.`,
        { httpStatus: 400, sessionId },
      );
    }

    if (activePlayers.length > gameDef.maxPlayers) {
      throw new GameError(
        GameErrorCode.TOO_MANY_PLAYERS,
        `Cannot exceed ${gameDef.maxPlayers} players.`,
        { httpStatus: 400, sessionId },
      );
    }

    // Content loading will be handled by the game loop initialization
    // after the status transition. The guard validates preconditions only.

    await next();
  };
}
