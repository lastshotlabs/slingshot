import type { Context } from 'hono';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scoring config
// ---------------------------------------------------------------------------

const scoringConfigSchema = z.object({
  /**
   * Scoring algorithm to apply when `updateScore` runs after a reaction change.
   *
   * - `net`           — weighted upvotes minus downvotes plus emoji bonus.
   * - `hot`           — Reddit-style time-decaying score (log₁₀ + time offset).
   * - `top`           — identical to `net`; time-window filter applied at list time.
   * - `controversial` — high engagement ÷ low net; surfaces polarising content.
   */
  algorithm: z
    .enum(['net', 'hot', 'top', 'controversial'])
    .default('net')
    .describe(
      'Score algorithm used after reaction changes. One of: net, hot, top, controversial. Default: net.',
    ),
  /** Weight applied to each upvote reaction. Default: `1`. */
  upvoteWeight: z
    .number()
    .default(1)
    .describe('Weight applied to each upvote reaction when scores are computed. Default: 1.'),
  /** Weight applied to each downvote reaction. Default: `1`. */
  downvoteWeight: z
    .number()
    .default(1)
    .describe('Weight applied to each downvote reaction when scores are computed. Default: 1.'),
  /**
   * Characteristic decay time (hours) for the `hot` algorithm.
   * Larger values produce slower decay. Default: `12`.
   */
  hotDecayHours: z
    .number()
    .default(12)
    .describe('Decay period in hours for the hot ranking algorithm. Default: 12.'),
  /**
   * Per-emoji score weights. Keys are emoji shortcodes (e.g. `'heart'`).
   * Unrecognised shortcodes contribute `0`. Default: `{}`.
   */
  emojiWeights: z
    .record(z.string(), z.number())
    .default({})
    .describe('Per-emoji score adjustments keyed by shortcode. Default: {}.'),
});

/**
 * Declarative scoring configuration for the community plugin.
 *
 * Consumed by `updateScore` (per-backend op.custom) and `computeNetScore` /
 * `computeHotScore` / `computeControversialScore` pure functions in
 * `src/lib/scoring.ts`. Config is frozen at plugin construction time and
 * closed over by the per-backend handler factories.
 *
 * @example
 * ```ts
 * scoring: {
 *   algorithm: 'hot',
 *   upvoteWeight: 1,
 *   downvoteWeight: 1,
 *   hotDecayHours: 24,
 *   emojiWeights: { heart: 0.5, fire: 1.5 },
 * }
 * ```
 */
export interface ScoringConfig {
  algorithm: 'net' | 'hot' | 'top' | 'controversial';
  upvoteWeight: number;
  downvoteWeight: number;
  hotDecayHours: number;
  emojiWeights: Record<string, number>;
}

/** Default scoring config — used when `config.scoring` is not provided. */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = Object.freeze({
  algorithm: 'net' as const,
  upvoteWeight: 1,
  downvoteWeight: 1,
  hotDecayHours: 12,
  emojiWeights: {},
});

/**
 * Admin gate for community moderation routes.
 *
 * Implement this interface to control access to admin-only community endpoints
 * and to record a tamper-proof audit trail of moderation decisions in tests or
 * custom integrations.
 *
 * @remarks
 * `createCommunityPlugin()` no longer accepts an `adminGate` config field on
 * the manifest-safe path. This interface remains exported for the internal
 * moderation middleware/runtime contracts that power tests and package-owned
 * integrations.
 */
export interface CommunityAdminGate {
  /**
   * Verify that the incoming request is authorised for admin-level community
   * operations.
   *
   * @param c - Hono request context.
   * @returns The authenticated subject and their roles, or `null` if the
   *   request is not authorised.
   */
  verifyRequest(c: Context): Promise<{ subject: string; roles: string[] } | null>;

  /**
   * Persist an audit log entry for a moderation action.
   *
   * Called by the audit-log middleware after every moderation operation
   * (report resolve/dismiss, ban apply/lift).
   *
   * @param entry - Details about the action, actor, and target.
   */
  logAuditEntry(entry: {
    action: string;
    resource: 'community';
    actorId: string;
    targetId?: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Outcome returned by the auto-moderation hook.
 *
 * - `'allow'`: content passes; proceed normally.
 * - `'flag'`: content is queued for human review but still visible.
 * - `'reject'`: content is blocked immediately; the request returns `400`.
 */
export type ModerationDecision = 'allow' | 'flag' | 'reject';

/**
 * Describes the content submitted to the auto-moderation hook.
 *
 * Passed to internal auto-moderation evaluators before a thread or reply is
 * written to the database.
 *
 * @remarks
 * `createCommunityPlugin()` no longer accepts an `autoModerationHook` config
 * field on the manifest-safe path. This type remains exported for the
 * package-owned moderation middleware/runtime contracts.
 */
export interface ModerationTarget {
  /** Whether the content is a thread or a reply. */
  type: 'thread' | 'reply';
  /** The (not-yet-persisted) entity ID. */
  id: string;
  /** User ID of the content author. */
  authorId: string;
  /** Raw body text of the submission. */
  body: string;
  /** Optional tenant scope when running in a multi-tenant environment. */
  tenantId?: string;
}

/**
 * WebSocket configuration for the community plugin.
 *
 * When provided, enables real-time presence tracking and typing indicators
 * on community containers. Each container gets a `live` channel at
 * `containers:{containerId}:live`.
 *
 * @remarks
 * The `wsEndpoint` must be declared in the app's `WsConfig.endpoints` with
 * `presence: true`. In config-driven mode only `wsEndpoint` is required — the plugin
 * self-wires its subscribe guard and incoming handlers during `setupPost` using
 * `SlingshotContext.wsPublish` and `SlingshotContext.ws`.
 *
 * @example
 * ```ts
 * // Manifest-compatible — only wsEndpoint is required:
 * createCommunityPlugin({
 *   containerCreation: 'admin',
 *   ws: { wsEndpoint: 'community' },
 * });
 *
 * ```
 */
export interface CommunityWsConfig {
  /**
   * Name of the WS endpoint to attach community channels to.
   * Must match a key in the app's `WsConfig.endpoints`.
   */
  wsEndpoint: string;
}

/**
 * Zod validation schema for {@link CommunityPluginConfig}.
 *
 * Used by `createCommunityPlugin()` to validate the raw config object at
 * construction time via `validatePluginConfig()`. Exported so callers can
 * pre-validate config before passing it in, or use it to generate JSON Schema
 * for tooling.
 *
 * @remarks
 * The schema is intentionally JSON-safe for config-driven mode. Live runtime
 * objects such as permissions adapters, admin gates, and callback hooks are
 * resolved from plugin/app state during setup rather than accepted here.
 *
 * @example
 * ```ts
 * import { communityPluginConfigSchema } from '@lastshotlabs/slingshot-community';
 *
 * const result = communityPluginConfigSchema.safeParse(rawConfig);
 * if (!result.success) {
 *   console.error(result.error.issues);
 * }
 * ```
 */
export const communityPluginConfigSchema = z.object({
  /** Controls who can create containers. 'admin' = admin-scoped permission; 'user' = any authenticated user. */
  containerCreation: z
    .enum(['admin', 'user'])
    .describe('Who can create containers. One of: admin, user.'),
  /**
   * Auth context bridging strategy.
   *
   * - `"auto"` registers middleware that reads the actor identity and roles from the auth plugin
   *   and sets `communityPrincipal` on the request context. Use when `slingshot-auth` is the
   *   identity provider.
   * - `"none"` requires the caller to provide `communityPrincipal` via external middleware.
   *   Use when identity comes from an external system or custom middleware.
   */
  authBridge: z
    .enum(['auto', 'none'])
    .optional()
    .describe(
      'Auth context bridging strategy. ' +
        '"auto" registers middleware that reads the actor identity and roles from the auth plugin ' +
        'and sets communityPrincipal on the request context. ' +
        '"none" requires the caller to provide communityPrincipal via external middleware. ' +
        'Use "auto" when slingshot-auth is the identity provider. ' +
        'Use "none" when identity comes from an external system or custom middleware.',
    ),
  /**
   * Scoring algorithm and weights for thread/reply score computation.
   *
   * When omitted, defaults to `{ algorithm: 'net', upvoteWeight: 1, downvoteWeight: 1,
   * hotDecayHours: 12, emojiWeights: {} }`. The frozen config value is closed over by
   * the `updateScore` per-backend handler at adapter-creation time.
   */
  scoring: scoringConfigSchema
    .optional()
    .describe(
      'Score algorithm and weight configuration for threads and replies. Omit to use the built-in net-scoring defaults.',
    ),
  /** Mount path for community routes. Default: '/community' */
  mountPath: z
    .string()
    .optional()
    .describe("URL path prefix for community routes. Omit to use '/community'."),
  /** Route entity names to skip mounting. */
  disableRoutes: z
    .array(z.string())
    .optional()
    .describe(
      'Entity route names to skip when mounting community routes. Omit to mount all routes.',
    ),
  /**
   * WebSocket configuration for presence and typing indicators.
   */
  ws: z
    .object({
      wsEndpoint: z
        .string()
        .describe(
          "WebSocket endpoint name to attach community live channels to. Must match a key in the app's WsConfig.endpoints.",
        ),
    })
    .optional()
    .describe(
      'WebSocket configuration for presence and typing indicators. Omit to disable live community channels.',
    ),
});

/**
 * Fully-typed configuration for the community plugin.
 *
 * Inferred from {@link communityPluginConfigSchema}. Pass a value of this type
 * to `createCommunityPlugin()`. Only `containerCreation` is required — all
 * other fields are optional.
 *
 * @remarks
 * **Field summary:**
 *
 * - `containerCreation` — `'admin'` restricts container creation to requests
 *   that pass the standard community container-write permission; `'user'`
 *   allows any authenticated user.
 * - `scoring` — Declarative score algorithm + weights used by the runtime
 *   `updateScore` operation.
 * - `mountPath` — Base path for all community routes. Defaults to
 *   `'/community'`.
 * - `disableRoutes` — Array of entity route names to skip mounting, useful for
 *   replacing a default route with a custom implementation.
 *
 * @example
 * ```ts
 * import type { CommunityPluginConfig } from '@lastshotlabs/slingshot-community';
 *
 * const config: CommunityPluginConfig = {
 *   containerCreation: 'admin',
 *   scoring: { algorithm: 'hot', hotDecayHours: 24 },
 *   mountPath: '/community',
 * };
 * ```
 */
export type CommunityPluginConfig = z.infer<typeof communityPluginConfigSchema>;
