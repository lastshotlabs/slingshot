#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EVENT_RELIABILITY_REPORT_PATH = resolve(
  import.meta.dir,
  '../.tmp/event-reliability/event-reliability-conformance.v1.json',
);

export const EVENT_RELIABILITY_CASES = [
  { id: 'outbox.atomic-commit', lane: 'unit', live: false },
  { id: 'outbox.atomic-rollback', lane: 'unit', live: false },
  { id: 'outbox.lease-recovery', lane: 'sqlite', live: false },
  { id: 'outbox.duplicate-publication', lane: 'unit', live: false },
  { id: 'inbox.deduplication', lane: 'unit', live: false },
  { id: 'inbox.rollback-and-race', lane: 'live', live: true },
  { id: 'lifecycle.shutdown', lane: 'unit', live: false },
  { id: 'operations.health-and-replay', lane: 'live', live: true },
  { id: 'topology.unsupported-combinations', lane: 'unit', live: false },
  { id: 'adoption.notifications-outbox-inbox', lane: 'live', live: true },
  {
    id: 'dispatch.postgres-bullmq',
    lane: 'live',
    live: true,
    store: 'postgres',
    transport: 'bullmq',
    receiptEvidence: true,
  },
  {
    id: 'dispatch.postgres-kafka',
    lane: 'live',
    live: true,
    store: 'postgres',
    transport: 'kafka',
    receiptEvidence: true,
  },
  {
    id: 'dispatch.sqlite-bullmq',
    lane: 'live',
    live: true,
    store: 'sqlite',
    transport: 'bullmq',
    receiptEvidence: true,
  },
  {
    id: 'dispatch.sqlite-kafka',
    lane: 'live',
    live: true,
    store: 'sqlite',
    transport: 'kafka',
    receiptEvidence: true,
  },
] as const;

type Lane = (typeof EVENT_RELIABILITY_CASES)[number]['lane'];
type CaseDefinition = (typeof EVENT_RELIABILITY_CASES)[number];

const LANE_COMMANDS: Readonly<Record<Lane, readonly string[]>> = {
  unit: [
    'bun',
    'test',
    'tests/unit/event-outbox-atomicity.test.ts',
    'tests/unit/event-inbox-consumer.test.ts',
    'tests/unit/event-reliability-bootstrap.test.ts',
    'tests/unit/event-reliability-operations.test.ts',
    'packages/slingshot-events/tests/dispatcher.test.ts',
    'packages/slingshot-notifications/tests/unit/builder.test.ts',
  ],
  sqlite: [
    'bun',
    'test',
    'packages/slingshot-events/tests/sqlite-dispatch.test.ts',
    'packages/slingshot-events/tests/sqlite-operations.test.ts',
  ],
  live: [
    'bun',
    'test',
    '--config',
    'bunfig.docker.toml',
    '--concurrency=1',
    'tests/docker/event-reliability-live.test.ts',
    'tests/docker/notifications-reliability-adoption.test.ts',
  ],
};

export interface EventReliabilityConformanceResult {
  readonly id: CaseDefinition['id'];
  readonly status: 'passed' | 'failed';
  readonly lane: Lane;
  readonly live: boolean;
  readonly durationMs: number;
  readonly store?: 'postgres' | 'sqlite';
  readonly transport?: 'bullmq' | 'kafka';
  readonly receiptEvidence?: boolean;
  readonly error?: { readonly name: string; readonly message: string };
}

export interface EventReliabilityConformanceReport {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly results: readonly EventReliabilityConformanceResult[];
}

function sanitize(value: string): string {
  return value
    .replace(/\b(?:postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/\S+/giu, '[redacted-url]')
    .slice(0, 2_000);
}

export function validateEventReliabilityConformanceReport(
  report: EventReliabilityConformanceReport,
): readonly string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push('Report schemaVersion must be 1.');
  if (report.results.length !== EVENT_RELIABILITY_CASES.length) {
    errors.push(
      `Expected ${EVENT_RELIABILITY_CASES.length} cases; received ${report.results.length}.`,
    );
  }
  for (const [index, expected] of EVENT_RELIABILITY_CASES.entries()) {
    const actual = report.results[index];
    if (!actual || actual.id !== expected.id) {
      errors.push(`Result ${index} must be '${expected.id}'.`);
      continue;
    }
    if (actual.status !== 'passed') {
      errors.push(`${actual.id} did not pass${actual.error ? `: ${actual.error.message}` : ''}.`);
    }
    if (expected.live && !actual.live) errors.push(`${actual.id} requires a live lane.`);
    if ('receiptEvidence' in expected && expected.receiptEvidence && !actual.receiptEvidence) {
      errors.push(`${actual.id} marked delivery without receipt evidence.`);
    }
  }
  const combinations = new Set(
    report.results
      .filter(result => result.store && result.transport && result.status === 'passed')
      .map(result => `${result.store}:${result.transport}`),
  );
  for (const combination of [
    'postgres:bullmq',
    'postgres:kafka',
    'sqlite:bullmq',
    'sqlite:kafka',
  ]) {
    if (!combinations.has(combination)) {
      errors.push(`Missing passed store/transport combination '${combination}'.`);
    }
  }
  return errors;
}

function gitRevision(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error('Unable to resolve git revision.');
  return new TextDecoder().decode(result.stdout).trim();
}

async function runLane(lane: Lane): Promise<{
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}> {
  const started = performance.now();
  const process = Bun.spawn([...LANE_COMMANDS[lane]], {
    cwd: resolve(import.meta.dir, '..'),
    env: Bun.env,
    stdout: 'inherit',
    stderr: 'pipe',
  });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  return {
    passed: exitCode === 0,
    durationMs: Math.round(performance.now() - started),
    error: exitCode === 0 ? undefined : sanitize(stderr || `Lane exited ${exitCode}`),
  };
}

export async function buildEventReliabilityConformanceReport(): Promise<EventReliabilityConformanceReport> {
  const laneResults = new Map<Lane, Awaited<ReturnType<typeof runLane>>>();
  for (const lane of ['unit', 'sqlite', 'live'] as const) {
    laneResults.set(lane, await runLane(lane));
  }
  return {
    schemaVersion: 1,
    revision: gitRevision(),
    results: EVENT_RELIABILITY_CASES.map(definition => {
      const lane = laneResults.get(definition.lane);
      const common = {
        ...definition,
        status: lane?.passed ? ('passed' as const) : ('failed' as const),
        durationMs: lane?.durationMs ?? 0,
      };
      return lane?.error
        ? { ...common, error: { name: 'ConformanceLaneError', message: lane.error } }
        : common;
    }),
  };
}

export async function main(): Promise<number> {
  const report = await buildEventReliabilityConformanceReport();
  mkdirSync(resolve(EVENT_RELIABILITY_REPORT_PATH, '..'), { recursive: true });
  writeFileSync(EVENT_RELIABILITY_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const errors = validateEventReliabilityConformanceReport(report);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[event-reliability] ${error}`);
    return 1;
  }
  console.log(
    `[event-reliability] ${report.results.length} required cases passed; report: ${EVENT_RELIABILITY_REPORT_PATH}`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
