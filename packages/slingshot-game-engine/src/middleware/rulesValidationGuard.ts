/**
 * Rules validation guard middleware.
 *
 * Resolves the game definition from the registry, applies any preset,
 * and validates the rules update against the game's Zod schema.
 * Rejects with `RULES_VALIDATION_FAILED` or `PRESET_NOT_FOUND` on failure.
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GameErrorCode } from '../errors';
import { mergeRules } from '../lib/rules';
import type { GameDefinition } from '../types/models';

interface RulesValidationGuardDeps {
  getSessionAdapter: () => { getById(id: string): Promise<Record<string, unknown> | null> };
  getRegistry: () => ReadonlyMap<string, GameDefinition>;
}

/**
 * Build the rules validation guard middleware.
 *
 * Registered under `'rulesValidationGuard'` in the named middleware map.
 */
export function buildRulesValidationGuard({
  getSessionAdapter,
  getRegistry,
}: RulesValidationGuardDeps) {
  return async (c: Context, next: Next) => {
    const sessionId = c.req.param('id');

    if (!sessionId) {
      throw new HTTPException(400, { message: 'Missing session ID.' });
    }

    const adapter = getSessionAdapter();
    const session = await adapter.getById(sessionId);

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found.' });
    }

    const gameDef = getRegistry().get(session.gameType as string);
    if (!gameDef) {
      throw new HTTPException(404, {
        message: `Game type not found. Code: ${GameErrorCode.GAME_TYPE_NOT_FOUND}`,
      });
    }

    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Request body required.' });
    }

    const rulesUpdate = (body as Record<string, unknown>).rules;
    if (rulesUpdate === undefined || rulesUpdate === null) {
      await next();
      return;
    }

    if (typeof rulesUpdate !== 'object') {
      throw new HTTPException(400, {
        message: `Rules must be an object. Code: ${GameErrorCode.RULES_VALIDATION_FAILED}`,
      });
    }

    const currentRules = (session.rules ?? {}) as Record<string, unknown>;

    try {
      mergeRules(gameDef, currentRules, rulesUpdate as Record<string, unknown>);
    } catch (err) {
      throw new HTTPException(400, {
        message: `Rules validation failed. Code: ${GameErrorCode.RULES_VALIDATION_FAILED}`,
        cause: err,
      });
    }

    await next();
  };
}
