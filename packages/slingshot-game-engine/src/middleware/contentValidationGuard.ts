/**
 * Content validation guard middleware.
 *
 * Validates that the content provider exists in the game definition
 * and that the content input passes the provider's schema.
 * Rejects with `CONTENT_PROVIDER_NOT_FOUND` or `CONTENT_VALIDATION_FAILED`.
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GameErrorCode } from '../errors';
import type { GameDefinition } from '../types/models';

interface ContentValidationGuardDeps {
  getSessionAdapter: () => { getById(id: string): Promise<Record<string, unknown> | null> };
  getRegistry: () => ReadonlyMap<string, GameDefinition>;
}

/**
 * Build the content validation guard middleware.
 *
 * Registered under `'contentValidationGuard'` in the named middleware map.
 */
export function buildContentValidationGuard({
  getSessionAdapter,
  getRegistry,
}: ContentValidationGuardDeps) {
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

    const { contentProvider } = body as Record<string, unknown>;

    if (contentProvider !== undefined && contentProvider !== null) {
      if (!gameDef.content) {
        throw new HTTPException(400, {
          message: `Game type does not support content providers. Code: ${GameErrorCode.CONTENT_PROVIDER_NOT_FOUND}`,
        });
      }

      if (typeof contentProvider !== 'string') {
        throw new HTTPException(400, {
          message: `contentProvider must be a string. Code: ${GameErrorCode.CONTENT_VALIDATION_FAILED}`,
        });
      }

      const providerName = contentProvider;
      const providers = gameDef.content.providers ?? {};
      if (!(providerName in providers)) {
        throw new HTTPException(400, {
          message: `Content provider '${providerName}' not found. Code: ${GameErrorCode.CONTENT_PROVIDER_NOT_FOUND}`,
        });
      }

      const providerDef = providers[providerName];
      const { contentInput } = body as Record<string, unknown>;

      if (providerDef.inputSchema && contentInput !== undefined) {
        const schema = providerDef.inputSchema as {
          safeParse?: (data: unknown) => { success: boolean; error?: unknown };
        };
        if (typeof schema.safeParse === 'function') {
          const result = schema.safeParse(contentInput);
          if (!result.success) {
            throw new HTTPException(400, {
              message: `Content input validation failed. Code: ${GameErrorCode.CONTENT_VALIDATION_FAILED}`,
              cause: result.error,
            });
          }
        }
      }
    }

    await next();
  };
}
