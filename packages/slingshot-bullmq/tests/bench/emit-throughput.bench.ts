/**
 * slingshot-bullmq: emit throughput benchmark
 *
 * Measures events/second throughput and latency percentiles for the non-durable
 * (in-process) emit path. The non-durable path does NOT use BullMQ — it
 * dispatches to in-process listeners synchronously. This benchmarks the
 * adapter's emit overhead.
 *
 * For the durable (BullMQ-backed) path, the adapter needs mock.module which
 * requires `bun test` context. Run with:
 *   BENCH=1 bun test tests/bench/emit-throughput.bench.ts
 *
 * Usage:
 *   bun run tests/bench/emit-throughput.bench.ts        # quick mode (100 iterations)
 *   BENCH=1 bun run tests/bench/emit-throughput.bench.ts # full bench (10,000 iterations)
 */

import { performance } from 'node:perf_hooks';
import { createBullMQAdapter } from '../../src/bullmqAdapter';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_FULL_BENCH = process.env.BENCH === '1';
const NON_DURABLE_ITERATIONS = IS_FULL_BENCH ? 10_000 : 100;

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
// Benchmark: Non-durable (in-process) emit
// ---------------------------------------------------------------------------

async function benchNonDurableEmit(): Promise<void> {
  const bus = createBullMQAdapter({ connection: {}, validation: 'off' });

  let callCount = 0;
  bus.on('bench:ping', () => {
    callCount++;
  });

  const latencies = new Float64Array(NON_DURABLE_ITERATIONS);

  // Warm-up: 100 iterations
  for (let i = 0; i < 100; i++) {
    bus.emit('bench:ping', { seq: i });
  }
  callCount = 0;

  const start = performance.now();
  for (let i = 0; i < NON_DURABLE_ITERATIONS; i++) {
    const t0 = performance.now();
    bus.emit('bench:ping', { seq: i });
    latencies[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;

  // Sort for percentile computation
  latencies.sort();
  const throughput = (NON_DURABLE_ITERATIONS / totalMs) * 1000;

  console.log(`[BENCH] bullmq-emit-throughput`);
  console.log(`[BENCH]   mode: non-durable`);
  console.log(`[BENCH]   iterations: ${NON_DURABLE_ITERATIONS}`);
  console.log(`[BENCH]   total-duration-ms: ${formatDuration(totalMs)}`);
  console.log(`[BENCH]   throughput-events-per-sec: ${Math.round(throughput)}`);
  console.log(`[BENCH]   latency-p50-ms: ${formatDuration(computePercentiles(latencies, 50))}`);
  console.log(`[BENCH]   latency-p95-ms: ${formatDuration(computePercentiles(latencies, 95))}`);
  console.log(`[BENCH]   latency-p99-ms: ${formatDuration(computePercentiles(latencies, 99))}`);
  console.log(`[BENCH]   listener-callbacks: ${callCount}`);

  await bus.shutdown();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[BENCH] === slingshot-bullmq emit throughput ===`);
if (!IS_FULL_BENCH) {
  console.log(`[BENCH] Quick mode (set BENCH=1 for full benchmark)`);
}

await benchNonDurableEmit();

console.log(`[BENCH] === done ===`);
process.exit(0);
