/**
 * Usage recording + the `AiUsageReader` capability.
 *
 * The thing this file must never get wrong: **`costUsd: null` (unknown) is not
 * `0` (free).** A summary that silently sums unknowns as zero under-reports the
 * bill and looks authoritative while doing it. So `AiUsageSummary` carries
 * `unpricedCalls` alongside `costUsd`, and every caller has to decide what to do
 * about it. That nullability survives all the way from the provider response,
 * through the entity column, into the summary.
 *
 * Writes are fire-and-forget against the store: a failed ledger INSERT must
 * never fail the generation a player is waiting on. It is a ledger, not a
 * transaction. The in-memory ring buffer is kept regardless, so `records()`
 * works with or without a database.
 */
import type { AiPackageConfig } from '../config';
import type { AiLogger } from '../provider/types';
import type {
  AiTags,
  AiUsage,
  AiUsageFilter,
  AiUsageReader,
  AiUsageRecordView,
  AiUsageSummary,
  SpendStatus,
} from '../types';
import type { AiUsageStore } from './seams';
import { type SpendGuard, windowStartFor } from './spend';

export interface UsageRecorder extends AiUsageReader {
  record(entry: {
    provider: string;
    model: string;
    operation: string;
    usage: AiUsage;
    latencyMs: number;
    tags?: AiTags;
  }): void;
  /**
   * Rebuild the spend guard's window from the persisted ledger. Called once, at
   * `setupPost`, so that a restart does not hand the app a fresh budget.
   */
  hydrateSpend(): Promise<void>;
}

const MAX_RECORDS = 5_000;

export function createUsageRecorder(
  config: AiPackageConfig,
  spend: SpendGuard,
  store?: AiUsageStore | null,
  logger?: AiLogger,
): UsageRecorder {
  const records: AiUsageRecordView[] = [];
  let sequence = 0;

  function matches(record: AiUsageRecordView, filter?: AiUsageFilter): boolean {
    if (!filter) return true;
    if (filter.since !== undefined && record.createdAt < filter.since) return false;
    if (filter.until !== undefined && record.createdAt > filter.until) return false;
    if (filter.provider !== undefined && record.provider !== filter.provider) return false;
    if (filter.model !== undefined && record.model !== filter.model) return false;
    if (filter.tags) {
      for (const [key, value] of Object.entries(filter.tags)) {
        if (record.tags?.[key] !== value) return false;
      }
    }
    return true;
  }

  function selected(filter?: AiUsageFilter): AiUsageRecordView[] {
    const hits = records.filter(record => matches(record, filter));
    return filter?.limit !== undefined ? hits.slice(-filter.limit) : hits;
  }

  return {
    record(entry) {
      if (!config.usage.enabled) return;

      const createdAt = Date.now();
      const tags = entry.tags ?? null;

      records.push({
        id: `usage_${++sequence}`,
        provider: entry.provider,
        model: entry.model,
        operation: entry.operation,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        cacheReadTokens: entry.usage.cacheReadTokens,
        costUsd: entry.usage.costUsd,
        latencyMs: entry.latencyMs,
        tags,
        createdAt,
      });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

      if (!config.usage.persist || !store) return;

      // Deliberately NOT awaited. The caller is a player waiting on a card; a
      // slow or broken ledger write must not become their problem.
      void store
        .write({
          provider: entry.provider,
          model: entry.model,
          operation: entry.operation,
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          cacheReadTokens: entry.usage.cacheReadTokens,
          cacheWriteTokens: entry.usage.cacheWriteTokens,
          costUsd: entry.usage.costUsd,
          latencyMs: entry.latencyMs,
          tags,
          createdAt: new Date(createdAt),
        })
        .catch((error: unknown) => {
          logger?.warn('ai: failed to persist a usage record; the call itself succeeded', {
            error: (error as Error).message,
          });
        });
    },

    async hydrateSpend(): Promise<void> {
      if (!store || !config.spend.enabled) return;
      try {
        const rows = await store.since(windowStartFor(config.spend.period));
        let total = 0;
        for (const row of rows) {
          // Unpriced rows contribute nothing to the KNOWN total — the honest
          // answer, and the reason `unpricedCalls` is tracked separately.
          if (row.costUsd !== null) total += row.costUsd;
        }
        spend.hydrate(total);
      } catch (error) {
        // A ledger we cannot read means we cannot know what has been spent. Say
        // so loudly: the guard is now working from zero, and an operator who
        // believes their hard limit is intact deserves to hear that it may not be.
        logger?.error(
          'ai: could not read the usage ledger at boot — the spend guard is starting from $0 for ' +
            'this period, so a hard limit may allow more than configured until the window rolls.',
          { error: (error as Error).message },
        );
      }
    },

    async summary(filter?: AiUsageFilter): Promise<AiUsageSummary> {
      const hits = selected(filter);
      let costUsd = 0;
      let unpricedCalls = 0;
      for (const record of hits) {
        if (record.costUsd === null) unpricedCalls++;
        else costUsd += record.costUsd;
      }
      return {
        calls: hits.length,
        inputTokens: hits.reduce((sum, r) => sum + r.inputTokens, 0),
        outputTokens: hits.reduce((sum, r) => sum + r.outputTokens, 0),
        cacheReadTokens: hits.reduce((sum, r) => sum + r.cacheReadTokens, 0),
        costUsd,
        unpricedCalls,
      };
    },

    async spend(): Promise<SpendStatus> {
      return spend.status();
    },

    async records(filter?: AiUsageFilter): Promise<readonly AiUsageRecordView[]> {
      return selected(filter);
    },
  };
}
