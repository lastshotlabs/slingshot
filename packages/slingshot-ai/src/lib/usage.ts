/**
 * Usage recording + the `AiUsageReader` capability.
 *
 * In-memory here. F4 persists records to an entity behind this same interface.
 *
 * The one thing this file must get right today, because it is the part that is
 * hard to retrofit: `costUsd: null` (unknown) is NOT `0` (free). A summary that
 * silently sums unknowns as zero under-reports the bill and looks authoritative
 * while doing it. So `AiUsageSummary` carries `unpricedCalls` alongside
 * `costUsd`, and every caller has to decide what to do about it.
 */
import type { AiPackageConfig } from '../config';
import type {
  AiTags,
  AiUsage,
  AiUsageFilter,
  AiUsageReader,
  AiUsageRecordView,
  AiUsageSummary,
  SpendStatus,
} from '../types';
import type { SpendGuard } from './spend';

export interface UsageRecorder extends AiUsageReader {
  record(entry: {
    provider: string;
    model: string;
    operation: string;
    usage: AiUsage;
    latencyMs: number;
    tags?: AiTags;
  }): void;
}

const MAX_RECORDS = 5_000;

export function createUsageRecorder(config: AiPackageConfig, spend: SpendGuard): UsageRecorder {
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
      records.push({
        id: `usage_${++sequence}`,
        provider: entry.provider,
        model: entry.model,
        operation: entry.operation,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        costUsd: entry.usage.costUsd,
        latencyMs: entry.latencyMs,
        tags: entry.tags ?? null,
        createdAt: Date.now(),
      });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
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
        // Cache-read tokens are folded into the record's input count by the
        // provider; a dedicated column arrives with persistence in F4.
        cacheReadTokens: 0,
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
