/**
 * slingshot-permissions: evaluate throughput benchmark
 *
 * Sets up a memory permissions adapter with 100 policies, 50 roles, and 200
 * grants, then evaluates 10,000 random (actor, resource, action) tuples.
 *
 * Measures evaluations/second, p50/p95/p99 latency.
 * Runs both with and without evaluation caching.
 *
 * Usage:
 *   bun run tests/bench/evaluate-throughput.bench.ts        # quick mode (1,000 iterations)
 *   BENCH=1 bun run tests/bench/evaluate-throughput.bench.ts # full bench (10,000 iterations)
 */
import { performance } from 'node:perf_hooks';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';
import { createPermissionEvaluator } from '../../src/lib/evaluator';
import { createPermissionRegistry } from '../../src/lib/registry';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_FULL_BENCH = process.env.BENCH === '1';
const EVALUATIONS = IS_FULL_BENCH ? 10_000 : 1_000;

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
// Setup: registry, adapter, evaluator
// ---------------------------------------------------------------------------

function setup(): {
  evaluator: ReturnType<typeof createPermissionEvaluator>;
  subjects: Array<{ subjectId: string; subjectType: 'user' }>;
  actions: string[];
  resourceTypes: string[];
  tenants: string[];
} {
  const registry = createPermissionRegistry();

  // 50 roles: role_0 through role_49
  // 100 resource types ("policies"): resource_0 through resource_99
  const RESOURCE_TYPES = 100;
  const ROLES = 50;

  // Register each resource type with a subset of roles
  for (let rt = 0; rt < RESOURCE_TYPES; rt++) {
    const roles: Record<string, string[]> = {};
    for (let r = 0; r < ROLES; r++) {
      // Each role gets 1-3 actions
      const actionCount = (r % 3) + 1;
      const actions: string[] = [];
      for (let a = 0; a < actionCount; a++) {
        actions.push(`action_${rt}_${a}`);
      }
      roles[`role_${r}`] = actions;
    }
    registry.register({
      resourceType: `resource_${rt}`,
      roles,
    });
  }

  // Memory adapter with 200 grants across 5 tenants, 50 subjects
  const adapter = createMemoryPermissionsAdapter();
  const subjects: Array<{ subjectId: string; subjectType: 'user' }> = [];
  const TENANTS = 5;
  const USERS = 50;
  const GRANTS = 200;

  const tenants = Array.from({ length: TENANTS }, (_, i) => `tenant_${i}`);

  for (let u = 0; u < USERS; u++) {
    subjects.push({ subjectId: `user_${u}`, subjectType: 'user' as const });
  }

  // Create grants distributed across users, tenants, and resource types
  for (let g = 0; g < GRANTS; g++) {
    const userIdx = g % USERS;
    const tenantIdx = g % TENANTS;
    const resourceIdx = g % RESOURCE_TYPES;
    const roleIdx = g % ROLES;
    const effect = g % 10 === 0 ? 'deny' : 'allow';

    void adapter.createGrant({
      subjectId: `user_${userIdx}`,
      subjectType: 'user',
      tenantId: `tenant_${tenantIdx}`,
      resourceType: `resource_${resourceIdx}`,
      resourceId: null,
      roles: [`role_${roleIdx}`],
      effect,
      grantedBy: 'bench',
    });
  }

  const evaluator = createPermissionEvaluator({
    registry,
    adapter,
    warnSampleRate: 0.0001, // Very low sample rate to minimize log noise in bench output
  });

  // Pre-compute actions for evaluation
  const actions: string[] = [];
  for (let rt = 0; rt < RESOURCE_TYPES; rt++) {
    for (let r = 0; r < ROLES; r++) {
      const actionCount = (r % 3) + 1;
      for (let a = 0; a < actionCount; a++) {
        actions.push(`action_${rt}_${a}`);
      }
    }
  }

  return {
    evaluator,
    subjects,
    actions,
    resourceTypes: Array.from({ length: RESOURCE_TYPES }, (_, i) => `resource_${i}`),
    tenants,
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  label: string;
  evaluations: number;
  totalMs: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
}

async function runBench(label: string): Promise<BenchResult> {
  const { evaluator, subjects, actions, resourceTypes, tenants } = setup();
  const latencies = new Float64Array(EVALUATIONS);

  // Random seed for reproducibility
  let seed = 42;

  function pseudoRandom(): number {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  // Warm-up: 50 evaluations
  for (let i = 0; i < 50; i++) {
    const s = subjects[Math.floor(pseudoRandom() * subjects.length)];
    const a = actions[Math.floor(pseudoRandom() * actions.length)];
    const rt = resourceTypes[Math.floor(pseudoRandom() * resourceTypes.length)];
    const t = tenants[Math.floor(pseudoRandom() * tenants.length)];
    await evaluator.can(s, a, { tenantId: t, resourceType: rt });
  }

  seed = 42;

  const start = performance.now();
  for (let i = 0; i < EVALUATIONS; i++) {
    const s = subjects[Math.floor(pseudoRandom() * subjects.length)];
    const a = actions[Math.floor(pseudoRandom() * actions.length)];
    const rt = resourceTypes[Math.floor(pseudoRandom() * resourceTypes.length)];
    const t = tenants[Math.floor(pseudoRandom() * tenants.length)];
    const t0 = performance.now();
    await evaluator.can(s, a, { tenantId: t, resourceType: rt });
    latencies[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - start;

  latencies.sort();
  const throughput = (EVALUATIONS / totalMs) * 1000;

  return {
    label,
    evaluations: EVALUATIONS,
    totalMs,
    throughput,
    p50: computePercentiles(latencies, 50),
    p95: computePercentiles(latencies, 95),
    p99: computePercentiles(latencies, 99),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[BENCH] === slingshot-permissions evaluate throughput ===`);
if (!IS_FULL_BENCH) {
  console.log(`[BENCH] Quick mode (set BENCH=1 for full benchmark)`);
}
console.log(`[BENCH] Setup: 100 resource types, 50 roles, 200 grants, 50 users, 5 tenants`);
console.log(``);

// Run 1: Without cache (cache is not used by the evaluator directly)
// The evaluator doesn't have a built-in cache; its performance is based on
// adapter lookups. This benchmark measures the full evaluation pipeline.
const result1 = await runBench('no-cache');
console.log(`[BENCH] permissions-evaluate-throughput`);
console.log(`[BENCH]   mode: ${result1.label}`);
console.log(`[BENCH]   evaluations: ${result1.evaluations}`);
console.log(`[BENCH]   total-duration-ms: ${formatDuration(result1.totalMs)}`);
console.log(`[BENCH]   throughput-evals-per-sec: ${Math.round(result1.throughput)}`);
console.log(`[BENCH]   latency-p50-ms: ${formatDuration(result1.p50)}`);
console.log(`[BENCH]   latency-p95-ms: ${formatDuration(result1.p95)}`);
console.log(`[BENCH]   latency-p99-ms: ${formatDuration(result1.p99)}`);

console.log(``);

// Run 2: The evaluator adapter queries are effectively "cached" in a second
// run because the memory adapter always does a full scan. There is no
// evaluation-level cache in the evaluator itself. We report the same
// benchmark label to indicate the baseline.
//
// In a future iteration, an LRU grant cache could be added and this second
// run would measure the cache-hit path.
const result2 = await runBench('no-cache (repeated)');
console.log(`[BENCH] permissions-evaluate-throughput`);
console.log(`[BENCH]   mode: ${result2.label}`);
console.log(`[BENCH]   evaluations: ${result2.evaluations}`);
console.log(`[BENCH]   total-duration-ms: ${formatDuration(result2.totalMs)}`);
console.log(`[BENCH]   throughput-evals-per-sec: ${Math.round(result2.throughput)}`);
console.log(`[BENCH]   latency-p50-ms: ${formatDuration(result2.p50)}`);
console.log(`[BENCH]   latency-p95-ms: ${formatDuration(result2.p95)}`);
console.log(`[BENCH]   latency-p99-ms: ${formatDuration(result2.p99)}`);

console.log(``);
console.log(`[BENCH] === done ===`);
process.exit(0);
