/**
 * The usage ledger.
 *
 * **This entity deliberately has NO `routes` key, and that is the point.**
 *
 * Omitting `routes` makes the framework mount no router at all
 * (`createEntityPlugin.ts:682` — `if (config.routes || plannedRoutes.length > 0)`),
 * so there is zero HTTP surface. A framework package that quietly published
 * `GET /ai-usage` would be handing every caller a per-tag, per-model breakdown
 * of what the app spends and what it prompts with — a real leak, arrived at by
 * doing nothing. Reads go through `AiUsageCap` instead, so the app decides who
 * may see them and mounts its own route if it wants one.
 *
 * `tests/integration/boot.test.ts` asserts `GET /ai-usage → 404` so that adding
 * a `routes:` key here can never be a silent change.
 *
 * The ledger is also what makes the spend guard survive a restart: it is
 * re-read at `setupPost` to rebuild the current period's running total. Without
 * that, a crash-loop would reset the budget to zero on every boot — which is
 * the one failure mode a spend limit exists to prevent.
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

export const AiUsageRecord = defineEntity('AiUsageRecord', {
  namespace: 'slingshot-ai',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    provider: field.string(),
    model: field.string(),
    /** `generate` | `generateStructured` | `stream` | `moderate`. */
    operation: field.string(),
    inputTokens: field.integer({ default: 0 }),
    outputTokens: field.integer({ default: 0 }),
    cacheReadTokens: field.integer({ default: 0 }),
    cacheWriteTokens: field.integer({ default: 0 }),
    /**
     * NULL means the call could not be priced — it does NOT mean it was free.
     * Keeping the column nullable (rather than defaulting to 0) is what lets
     * `AiUsageSummary.unpricedCalls` stay honest all the way from the provider
     * response to a dashboard.
     */
    costUsd: field.number({ optional: true }),
    latencyMs: field.integer({ default: 0 }),
    /** App-supplied labels, e.g. `{ matchId, feature: 'deck-gen' }`. */
    tags: field.json({ optional: true }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [
    // The spend guard's hydration query: "everything since the window opened".
    index(['createdAt'], { direction: 'desc' }),
    index(['provider', 'model', 'createdAt'], { direction: 'desc' }),
  ],
  // NO `routes` key. See the file header — this is load-bearing, not an omission.
});
