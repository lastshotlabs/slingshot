/**
 * Session creation guard middleware.
 *
 * Validates the gameType exists in the registry, generates a join code,
 * and resolves rules from preset + overrides. Captures the game registry
 * and config via closure (Rule 3).
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GameError, GameErrorCode } from '../errors';
import type { GameDefinition } from '../types/models';
import { SessionCreateInputSchema } from '../validation/session';

interface SessionCreateGuardDeps {
  getRegistry: () => ReadonlyMap<string, GameDefinition>;
}

/** Characters for join codes (excluding ambiguous I, O, 0, 1). */
const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}

/**
 * Build the session create guard middleware.
 *
 * Registered under `'sessionCreateGuard'` in `RouteConfigDeps.middleware`.
 */
export function buildSessionCreateGuard({ getRegistry }: SessionCreateGuardDeps) {
  return async (c: Context, next: Next) => {
    const rawBody: unknown = await c.req.json();

    const result = SessionCreateInputSchema.safeParse(rawBody);
    if (!result.success) {
      throw new HTTPException(400, {
        message: result.error.issues.map(i => i.message).join('; '),
      });
    }

    const { gameType, rules: rulesOverrides, preset, content } = result.data;
    const registry = getRegistry();
    const gameDef = registry.get(gameType);

    if (!gameDef) {
      throw new GameError(GameErrorCode.GAME_TYPE_NOT_FOUND, `Game type '${gameType}' not found.`, {
        httpStatus: 404,
      });
    }

    // Resolve rules: preset → overrides → defaults → validate → freeze
    let resolvedRules: Record<string, unknown> = {};

    if (preset) {
      if (!(preset in gameDef.presets)) {
        throw new GameError(
          GameErrorCode.PRESET_NOT_FOUND,
          `Preset '${preset}' not found for '${gameType}'.`,
          {
            httpStatus: 400,
          },
        );
      }
      resolvedRules = { ...gameDef.presets[preset] };
    }

    if (rulesOverrides) {
      resolvedRules = { ...resolvedRules, ...rulesOverrides };
    }

    // Validate rules against the game definition's Zod schema
    const rulesResult = gameDef.rules.safeParse(resolvedRules);
    if (!rulesResult.success) {
      throw new GameError(GameErrorCode.RULES_VALIDATION_FAILED, 'Rules validation failed.', {
        httpStatus: 400,
        details: rulesResult.error,
      });
    }

    // Generate join code
    const joinCode = generateJoinCode(4);

    // Inject resolved data into the request body for entity creation
    const body = rawBody as Record<string, unknown>;
    body.rules = Object.freeze(rulesResult.data);
    body.joinCode = joinCode;
    body.hostUserId = c.get('authUserId') as string;
    body.contentConfig = content ?? null;

    await next();
  };
}
