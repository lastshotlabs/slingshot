/**
 * The seams between the orchestrator and the framework.
 *
 * Every one of these is STRUCTURAL — the real framework types satisfy them
 * without being imported here. Two reasons that matters:
 *
 *   1. The orchestrator stays unit-testable with three-line fakes, so the tests
 *      that assert the interesting behavior (fail-closed moderation, pre-flight
 *      spend, cache coalescing) don't have to boot an app.
 *   2. Every one of them is OPTIONAL. An app with no cache adapter, no queue,
 *      and no database still gets a fully working AI client — it just gets the
 *      in-memory versions, and says so.
 */

/** Satisfied by the framework's `CacheAdapter`. Strings only — we serialize. */
export interface AiCacheAdapter {
  readonly name: string;
  get(key: string): Promise<string | null>;
  /** `ttl` is in SECONDS. */
  set(key: string, value: string, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  isReady(): boolean;
}

/** Satisfied by the framework's `SlingshotEventBus` (via its dynamic overload). */
export interface AiEventBus {
  emit(event: string, payload: unknown): void;
}

/** One persisted usage row. Mirrors the `AiUsageRecord` entity. */
export interface AiUsageRow {
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** `null` = unpriced. NOT zero. */
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly tags: Record<string, string> | null;
  readonly createdAt: Date;
}

/**
 * Persistence for the usage ledger. Satisfied by the entity adapter.
 *
 * `write` is deliberately fire-and-forget from the orchestrator's point of view:
 * a failed usage INSERT must never fail the generation the user is waiting on.
 * It is a ledger, not a transaction.
 */
export interface AiUsageStore {
  write(row: AiUsageRow): Promise<void>;
  /** Rows created at or after `since`. Used to rebuild the spend window at boot. */
  since(since: Date): Promise<readonly AiUsageRow[]>;
}
