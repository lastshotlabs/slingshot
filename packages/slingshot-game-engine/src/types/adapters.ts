/**
 * Provider interfaces for the game engine.
 *
 * These are swappable contracts (Rule 8) for replay storage,
 * content provision, and per-player rate limiting.
 */
import type { ReplayEntry } from './models';

/**
 * Replay log storage adapter.
 *
 * The default implementation stores entries in-memory per session.
 * Alternative implementations can persist to a durable store
 * (e.g., MongoDB collection, S3 objects).
 */
export interface ReplayStore {
  /**
   * Append one or more replay entries for a session.
   * Entries MUST be persisted durably before returning — an input is
   * not considered committed until this call succeeds.
   */
  appendReplayEntries(sessionId: string, entries: ReplayEntry[]): Promise<void>;

  /**
   * Read replay entries with cursor-based pagination.
   *
   * @param sessionId - Session to read from.
   * @param from - Start sequence (exclusive). 0 for beginning.
   * @param limit - Max entries to return.
   */
  getReplayEntries(
    sessionId: string,
    from: number,
    limit: number,
  ): Promise<{ entries: ReplayEntry[]; total: number; hasMore: boolean }>;

  /**
   * Delete all replay entries for a session.
   * Called during session cleanup.
   */
  deleteReplayEntries(sessionId: string): Promise<void>;
}

/**
 * Content provider contract.
 *
 * Game definitions declare content providers by name. Each provider
 * loads content from an external source (API, database, user upload)
 * and validates it against the game's content schema.
 */
export interface ContentProvider {
  /** Unique provider name. */
  readonly name: string;

  /** Zod schema for provider-specific input (e.g., playlist URL, deck ID). */
  readonly inputSchema?: unknown;

  /**
   * Load content from the source.
   * Called during game start after rules are resolved.
   *
   * @param input - Provider-specific input validated against `inputSchema`.
   * @returns The loaded content, validated against the game's content schema.
   */
  load(input: unknown): unknown;

  /**
   * Optional validation hook. Called after `load()` to verify content
   * meets game-specific requirements (e.g., minimum number of questions).
   */
  validate?(data: unknown): boolean;
}

/**
 * Rate limit backend interface.
 *
 * Matches the pattern from `slingshot-polls`. The game engine uses this
 * for per-player per-channel rate limiting — the only rate limiter
 * the engine implements itself.
 */
export interface RateLimitBackend {
  /**
   * Check if a request is within rate limits.
   *
   * @param key - Composite key (e.g., `session:channel:userId`).
   * @param window - Window size in milliseconds.
   * @param max - Max requests in window.
   */
  check(
    key: string,
    window: number,
    max: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

/**
 * Session lease adapter for multi-instance mode (§32).
 *
 * Uses Redis-backed atomic leases to ensure a session is only active
 * on one instance at a time. The owning instance renews the lease
 * periodically. If the lease expires, another instance can claim it.
 */
export interface SessionLeaseAdapter {
  /**
   * Attempt to acquire or renew a lease for a session.
   *
   * @param sessionId - Session to lease.
   * @param instanceId - This instance's identifier.
   * @param ttlMs - Lease TTL in milliseconds.
   * @returns `true` if the lease was acquired/renewed, `false` if held by another instance.
   */
  acquireOrRenew(sessionId: string, instanceId: string, ttlMs: number): Promise<boolean>;

  /**
   * Release a lease for a session.
   * Only succeeds if the current instance holds the lease.
   */
  release(sessionId: string, instanceId: string): Promise<boolean>;

  /**
   * Get the current lease holder for a session.
   * Returns `null` if no lease is active.
   */
  getHolder(sessionId: string): Promise<string | null>;
}
