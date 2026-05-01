/**
 * slingshot-search: query throughput benchmark
 *
 * Sets up a test search provider (in-memory mock that simulates ~10ms response
 * time) and executes 1,000 search queries with varying filters.
 *
 * Measures queries/second, p50/p95/p99 latency.
 * Tests with circuit breaker open vs closed.
 *
 * Usage:
 *   bun run tests/bench/search-throughput.bench.ts        # quick mode (100 iterations)
 *   BENCH=1 bun run tests/bench/search-throughput.bench.ts # full bench (1,000 iterations)
 */

import { performance } from 'node:perf_hooks';
import type { SearchProvider, SearchIndexSettings } from '../../src/types/provider';
import type { SearchQuery } from '../../src/types/query';
import type { SearchResponse } from '../../src/types/response';
import { createSearchCircuitBreaker, SearchCircuitOpenError } from '../../src/searchCircuitBreaker';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_FULL_BENCH = process.env.BENCH === '1';
const QUERIES = IS_FULL_BENCH ? 1_000 : 100;
const SIMULATED_LATENCY_MS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePercentiles(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatDuration(ms: number): string {
  return ms.toFixed(3);
}

// ---------------------------------------------------------------------------
// Mock search provider with simulated ~10ms latency
// ---------------------------------------------------------------------------

function createLatencySimulatingProvider(latencyMs: number): SearchProvider {
  const docs = new Map<string, Record<string, unknown>>();

  // Pre-populate with some documents for realistic result sizes
  for (let i = 0; i < 1000; i++) {
    docs.set(`doc_${i}`, {
      id: `doc_${i}`,
      title: `Document ${i} about search benchmarks`,
      status: i % 3 === 0 ? 'published' : i % 3 === 1 ? 'draft' : 'archived',
      category: `category_${i % 10}`,
      score: Math.random(),
    });
  }

  const provider: SearchProvider = {
    name: 'bench-mock',

    // Lifecycle
    async connect(): Promise<void> {
      // No-op
    },

    async healthCheck() {
      const start = performance.now();
      await new Promise(r => setTimeout(r, 1));
      return {
        healthy: true,
        provider: 'bench-mock',
        latencyMs: Math.round(performance.now() - start),
      };
    },

    async teardown(): Promise<void> {
      docs.clear();
    },

    // Index management (minimal implementations)
    async createOrUpdateIndex(_indexName: string, _settings: SearchIndexSettings) {
      return undefined;
    },

    async deleteIndex(_indexName: string): Promise<void> {
      // No-op
    },

    async listIndexes() {
      return [{ name: 'bench-index', documentCount: docs.size, updatedAt: new Date() }];
    },

    async getIndexSettings(_indexName: string): Promise<SearchIndexSettings> {
      return {
        searchableFields: ['title'],
        filterableFields: ['status', 'category'],
        sortableFields: ['score'],
        facetableFields: ['status', 'category'],
      };
    },

    // Document operations
    async indexDocument(
      _indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      docs.set(documentId, { ...document });
    },

    async deleteDocument(_indexName: string, documentId: string): Promise<void> {
      docs.delete(documentId);
    },

    async indexDocuments(
      _indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ) {
      for (const doc of documents) {
        const id = String(doc[primaryKey] ?? crypto.randomUUID());
        docs.set(id, { ...doc });
      }
      return undefined;
    },

    async deleteDocuments(_indexName: string, documentIds: ReadonlyArray<string>) {
      for (const id of documentIds) docs.delete(id);
      return undefined;
    },

    async clearIndex(_indexName: string) {
      docs.clear();
      return undefined;
    },

    // Search (with simulated latency)
    async search(_indexName: string, query: SearchQuery): Promise<SearchResponse> {
      // Simulate network/provider latency
      await new Promise(r => setTimeout(r, latencyMs));

      // Perform minimal in-memory matching for realistic result construction
      const allDocs = Array.from(docs.values());
      let results = allDocs;

      // Basic filter support
      if (query.filter && 'field' in query.filter) {
        const cond = query.filter as { field: string; op: string; value: unknown };
        results = allDocs.filter(doc => {
          const val = (doc as Record<string, unknown>)[cond.field];
          if (cond.op === '=') return val === cond.value;
          if (cond.op === '!=') return val !== cond.value;
          if (cond.op === 'EXISTS') return val !== undefined;
          return true;
        });
      }

      // Text matching (basic substring)
      if (query.q && query.q !== '*') {
        const q = query.q.toLowerCase();
        results = results.filter(doc => {
          const title = String((doc as Record<string, unknown>).title ?? '').toLowerCase();
          return title.includes(q);
        });
      }

      // Sort by score descending
      results.sort(
        (a, b) =>
          Number((b as Record<string, unknown>).score ?? 0) -
          Number((a as Record<string, unknown>).score ?? 0),
      );

      // Pagination
      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;
      const paged = results.slice(offset, offset + limit);
      const totalHits = results.length;

      return {
        hits: paged.map(doc => ({
          document: doc,
          score: (doc as Record<string, unknown>).score as number,
        })),
        totalHits,
        totalHitsRelation: 'exact',
        query: query.q,
        processingTimeMs: latencyMs,
        indexName: _indexName,
      };
    },

    async multiSearch(
      queries: ReadonlyArray<{ indexName: string; query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      return Promise.all(queries.map(q => provider.search(q.indexName, q.query)));
    },

    async suggest(_indexName: string, query: { q: string; limit?: number; fields?: ReadonlyArray<string>; highlight?: boolean; filter?: unknown }) {
      await new Promise(r => setTimeout(r, latencyMs));
      return {
        suggestions: [{ text: 'suggestion', score: 1, field: 'title' }],
        processingTimeMs: latencyMs,
      };
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Benchmark: search with circuit breaker closed
// ---------------------------------------------------------------------------

async function runBenchClosed(label: string): Promise<{
  label: string;
  queries: number;
  totalMs: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
}> {
  const provider = createLatencySimulatingProvider(SIMULATED_LATENCY_MS);

  const latencies = new Float64Array(QUERIES);
  const categories = ['category_0', 'category_1', 'category_2', 'category_3', 'category_4'];
  const statuses = ['published', 'draft', 'archived'];

  // Warm-up (5 queries)
  for (let i = 0; i < 5; i++) {
    await provider.search('bench-index', {
      q: 'benchmark',
      filter: { field: 'status', op: '=', value: 'published' },
      limit: 10,
    });
  }

  const start = performance.now();
  for (let i = 0; i < QUERIES; i++) {
    const cat = categories[i % categories.length];
    const status = statuses[i % statuses.length];
    const t0 = performance.now();

    await provider.search('bench-index', {
      q: i % 2 === 0 ? 'benchmark' : 'document',
      filter: { field: 'category', op: '=', value: cat },
      sort: [{ field: 'score', direction: 'desc' }],
      limit: 10 + (i % 10),
      offset: 0,
      facets: ['status'],
    });

    latencies[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;

  latencies.sort();
  const throughput = (QUERIES / totalMs) * 1000;

  await provider.teardown();

  return { label, queries: QUERIES, totalMs, throughput, p50: computePercentiles(latencies, 50), p95: computePercentiles(latencies, 95), p99: computePercentiles(latencies, 99) };
}

// ---------------------------------------------------------------------------
// Benchmark: with circuit breaker open
// ---------------------------------------------------------------------------

async function runBenchBreakerOpen(label: string): Promise<{
  label: string;
  queries: number;
  totalMs: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
}> {
  const breaker = createSearchCircuitBreaker({ providerKey: 'bench-mock' });

  // Trip the breaker
  for (let i = 0; i < 6; i++) {
    try {
      await breaker.guard(async () => {
        throw new Error('provider error');
      });
    } catch {
      // Expected
    }
  }

  const latencies = new Float64Array(QUERIES);

  const start = performance.now();
  for (let i = 0; i < QUERIES; i++) {
    const t0 = performance.now();
    try {
      await breaker.guard(async () => {
        await new Promise(r => setTimeout(r, SIMULATED_LATENCY_MS));
        return { ok: true };
      });
    } catch (err) {
      // Circuit open errors are expected
    }
    latencies[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;

  latencies.sort();
  const throughput = (QUERIES / totalMs) * 1000;

  return { label, queries: QUERIES, totalMs, throughput, p50: computePercentiles(latencies, 50), p95: computePercentiles(latencies, 95), p99: computePercentiles(latencies, 99) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[BENCH] === slingshot-search query throughput ===`);
if (!IS_FULL_BENCH) {
  console.log(`[BENCH] Quick mode (set BENCH=1 for full benchmark)`);
}
console.log(`[BENCH] Simulated provider latency: ${SIMULATED_LATENCY_MS}ms`);
console.log(``);

const r1 = await runBenchClosed('circuit-breaker-closed');
console.log(`[BENCH] search-query-throughput`);
console.log(`[BENCH]   mode: ${r1.label}`);
console.log(`[BENCH]   queries: ${r1.queries}`);
console.log(`[BENCH]   total-duration-ms: ${formatDuration(r1.totalMs)}`);
console.log(`[BENCH]   throughput-queries-per-sec: ${Math.round(r1.throughput)}`);
console.log(`[BENCH]   latency-p50-ms: ${formatDuration(r1.p50)}`);
console.log(`[BENCH]   latency-p95-ms: ${formatDuration(r1.p95)}`);
console.log(`[BENCH]   latency-p99-ms: ${formatDuration(r1.p99)}`);

if (IS_FULL_BENCH) {
  console.log(``);

  const r2 = await runBenchBreakerOpen('circuit-breaker-open');
  console.log(`[BENCH] search-query-throughput`);
  console.log(`[BENCH]   mode: ${r2.label}`);
  console.log(`[BENCH]   queries: ${r2.queries}`);
  console.log(`[BENCH]   total-duration-ms: ${formatDuration(r2.totalMs)}`);
  console.log(`[BENCH]   throughput-failfast-per-sec: ${Math.round(r2.throughput)}`);
  console.log(`[BENCH]   latency-p50-ms: ${formatDuration(r2.p50)}`);
  console.log(`[BENCH]   latency-p95-ms: ${formatDuration(r2.p95)}`);
  console.log(`[BENCH]   latency-p99-ms: ${formatDuration(r2.p99)}`);
}

console.log(``);
console.log(`[BENCH] === done ===`);
process.exit(0);
