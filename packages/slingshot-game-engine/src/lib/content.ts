/**
 * Content providers.
 *
 * Loading, validation, and user-supplied content handling.
 * Content is loaded during game start and frozen for session lifetime.
 *
 * See spec §18 for the full contract.
 */
import type { z } from 'zod';
import { GameError, GameErrorCode } from '../errors';
import type { GameDefinition } from '../types/models';

/** Resolved content ready for use in a game session. */
export interface ResolvedContent {
  readonly provider: string;
  readonly data: unknown;
}

/**
 * Load and validate content for a game session.
 *
 * @param gameDef - The game definition.
 * @param contentConfig - Content configuration from session creation.
 * @returns Resolved content, or null if no content is required.
 */
export async function loadContent(
  gameDef: GameDefinition,
  contentConfig?: {
    provider: string;
    input?: unknown;
    data?: unknown;
  } | null,
): Promise<ResolvedContent | null> {
  const contentDef = gameDef.content;
  if (!contentDef) return null;

  if (!contentConfig) {
    if (contentDef.required) {
      throw new GameError(
        GameErrorCode.CONTENT_LOAD_FAILED,
        'Content is required but not provided.',
        { httpStatus: 400 },
      );
    }
    return null;
  }

  const { provider: providerName, input, data: rawData } = contentConfig;

  // Widen the schema type — GameDefinition erases TContent to undefined,
  // but at runtime it may hold a ZodType.
  const contentSchema = contentDef.schema as z.ZodType | undefined;

  // Custom provider — data is provided directly
  if (providerName === 'custom') {
    if (contentSchema) {
      const result = contentSchema.safeParse(rawData);
      if (!result.success) {
        throw new GameError(
          GameErrorCode.CONTENT_VALIDATION_FAILED,
          'Custom content validation failed.',
          { httpStatus: 400, details: result.error },
        );
      }
      return { provider: 'custom', data: Object.freeze(result.data) };
    }
    return { provider: 'custom', data: Object.freeze(rawData) };
  }

  // Named provider
  const providerDef = contentDef.providers?.[providerName];
  if (!providerDef) {
    throw new GameError(
      GameErrorCode.CONTENT_PROVIDER_NOT_FOUND,
      `Content provider '${providerName}' not found.`,
      { httpStatus: 400 },
    );
  }

  // Validate provider input
  if (providerDef.inputSchema) {
    const inputSchema = providerDef.inputSchema as {
      safeParse(v: unknown): { success: boolean; error?: unknown };
    };
    const inputResult = inputSchema.safeParse(input);
    if (!inputResult.success) {
      throw new GameError(
        GameErrorCode.CONTENT_VALIDATION_FAILED,
        'Content provider input validation failed.',
        { httpStatus: 400, details: inputResult.error },
      );
    }
  }

  // Load content
  let loadedData: unknown;
  try {
    loadedData = await providerDef.load(input);
  } catch (err) {
    throw new GameError(
      GameErrorCode.CONTENT_LOAD_FAILED,
      `Content provider '${providerName}' failed to load.`,
      { httpStatus: 500, cause: err },
    );
  }

  // Validate loaded content against game schema
  if (contentSchema) {
    const result = contentSchema.safeParse(loadedData);
    if (!result.success) {
      throw new GameError(
        GameErrorCode.CONTENT_VALIDATION_FAILED,
        'Loaded content failed schema validation.',
        { httpStatus: 500, details: result.error },
      );
    }
    loadedData = result.data;
  }

  // Provider-specific validation
  if (providerDef.validate && !providerDef.validate(loadedData)) {
    throw new GameError(
      GameErrorCode.CONTENT_INSUFFICIENT,
      'Content provider validation failed (insufficient content).',
      { httpStatus: 400 },
    );
  }

  return { provider: providerName, data: Object.freeze(loadedData) };
}
