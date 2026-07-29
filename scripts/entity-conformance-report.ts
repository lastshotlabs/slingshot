#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENTITY_BACKEND_CAPABILITIES,
  ENTITY_OPERATION_KINDS,
  type EntityBackendCapability,
  type EntityBackendProfile,
  type StoreType,
} from '@lastshotlabs/slingshot-core';
import { ENTITY_BACKEND_PROFILES } from '../packages/slingshot-entity/src/configDriven/backendProfiles';
import { ENTITY_CONFORMANCE_CATALOG } from '../packages/slingshot-entity/src/testing/catalog';
import type {
  EntityConformanceCase,
  EntityConformanceDriver,
  EntityConformanceResult,
} from '../packages/slingshot-entity/src/testing/conformance';
import { runEntityConformance } from '../packages/slingshot-entity/src/testing/conformance';
import { createMemoryEntityConformanceDriver } from '../packages/slingshot-entity/src/testing/drivers/memory';
import { createMongoEntityConformanceDriver } from '../packages/slingshot-entity/src/testing/drivers/mongo';
import { createPostgresEntityConformanceDriver } from '../packages/slingshot-entity/src/testing/drivers/postgres';
import { createRedisEntityConformanceDriver } from '../packages/slingshot-entity/src/testing/drivers/redis';
import { createSqliteEntityConformanceDriver } from '../packages/slingshot-entity/src/testing/drivers/sqlite';

export const ENTITY_CONFORMANCE_STORES = [
  'memory',
  'sqlite',
  'postgres',
  'mongo',
  'redis',
] as const satisfies readonly StoreType[];

export const ENTITY_CONFORMANCE_REPORT_PATH = resolve(
  import.meta.dir,
  '../.tmp/entity-conformance/entity-conformance.v3.json',
);

export const TRANSACTION_GUARANTEE_CATALOG = [
  {
    id: 'declarative.commit',
    description: 'Declarative transaction commits cross-entity writes.',
    caseIds: ['composition.transaction-commit'],
  },
  {
    id: 'declarative.rollback',
    description: 'Declarative transaction rolls back earlier cross-entity writes.',
    caseIds: ['composition.transaction-rollback'],
  },
  {
    id: 'scope.two-entity-commit',
    description: 'Package-service scope commits two entity adapters atomically.',
    caseIds: ['scope.two-entity-commit'],
  },
  {
    id: 'scope.two-entity-rollback',
    description: 'Package-service scope rolls back two entity adapters atomically.',
    caseIds: ['scope.two-entity-rollback'],
  },
  {
    id: 'scope.same-store-nesting',
    description: 'Same-store nesting reuses the exact active scope.',
    caseIds: ['scope.same-store-nesting'],
  },
  {
    id: 'scope.cross-store-rejection',
    description: 'Cross-store nesting rejects before independent work starts.',
    caseIds: ['scope.cross-store-rejection'],
  },
  {
    id: 'scope.closed-adapter-rejection',
    description: 'Retained scoped adapters reject after callback closure.',
    caseIds: ['scope.closed-adapter-rejection'],
  },
] as const;

export const CONCURRENCY_GUARANTEE_CATALOG = [
  {
    id: 'version.update',
    description: 'Versioned updates validate, compare, race, increment, and preserve scope.',
    stores: ['memory', 'sqlite', 'postgres', 'mongo'],
    caseIds: [
      'concurrency.version-update',
      'concurrency.version-precondition',
      'concurrency.version-update-race',
      'concurrency.version-optional-guard',
      'concurrency.version-scope',
    ],
  },
  {
    id: 'version.delete',
    description: 'Versioned hard and soft deletes compare atomically and preserve scope.',
    stores: ['memory', 'sqlite', 'postgres', 'mongo'],
    caseIds: [
      'concurrency.version-delete',
      'concurrency.version-scope',
      'concurrency.version-soft-delete',
    ],
  },
  {
    id: 'version.transaction-scope',
    description: 'Transaction-scoped adapters preserve version compare-and-write semantics.',
    stores: ['sqlite', 'postgres'],
    caseIds: ['concurrency.version-transaction-scope'],
  },
] as const;

export interface TransactionGuaranteeEvidence {
  readonly id: (typeof TRANSACTION_GUARANTEE_CATALOG)[number]['id'];
  readonly description: string;
  readonly stores: readonly ['sqlite', 'postgres'];
  readonly caseIds: readonly string[];
}

/** Required passing evidence for a public optimistic-concurrency guarantee. */
export interface ConcurrencyGuaranteeEvidence {
  /** Stable guarantee identifier. */
  readonly id: (typeof CONCURRENCY_GUARANTEE_CATALOG)[number]['id'];
  /** Human-readable guarantee summary. */
  readonly description: string;
  /** Backends that claim atomic version concurrency. */
  readonly stores: readonly StoreType[];
  /** Conformance cases that must pass on every claimed backend. */
  readonly caseIds: readonly string[];
}

/** Complete ephemeral evidence emitted by the entity conformance CI lane. */
export interface EntityConformanceReport {
  /** Report schema version. */
  readonly schemaVersion: 3;
  /** Git revision exercised by this report. */
  readonly revision: string;
  /** Static semantic support claims in stable store order. */
  readonly profiles: Readonly<Record<StoreType, EntityBackendProfile>>;
  /** Per-store results in stable store and catalog order. */
  readonly results: readonly EntityConformanceResult[];
  /** Required SQLite/PostgreSQL evidence for every public transaction guarantee. */
  readonly transactionGuarantees: readonly TransactionGuaranteeEvidence[];
  /** Required backend evidence for every public optimistic-concurrency guarantee. */
  readonly concurrencyGuarantees: readonly ConcurrencyGuaranteeEvidence[];
}

function sanitizeError(error: unknown): { readonly name: string; readonly message: string } {
  const name = error instanceof Error ? error.name : 'Error';
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown conformance infrastructure error';
  return {
    name,
    message: rawMessage.replace(
      /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/\S+/giu,
      '[redacted-url]',
    ),
  };
}

function unsupportedCapabilities(
  profile: EntityBackendProfile,
  testCase: EntityConformanceCase,
): readonly EntityBackendCapability[] {
  return testCase.requires.filter(
    capability => profile.capabilities[capability].status === 'unsupported',
  );
}

export function expectedProfileSkipReason(
  profile: EntityBackendProfile,
  testCase: EntityConformanceCase,
): string | undefined {
  const unsupported = unsupportedCapabilities(profile, testCase);
  if (unsupported.length === 0) return undefined;
  const details = unsupported.map(capability => {
    const claim = profile.capabilities[capability];
    return `${capability}: ${claim.status === 'unsupported' ? claim.reason : ''}`;
  });
  return `Unsupported capabilities: ${details.join('; ')}`;
}

function infrastructureFailureResults(
  driver: EntityConformanceDriver,
  error: unknown,
): readonly EntityConformanceResult[] {
  const serialized = sanitizeError(error);
  return ENTITY_CONFORMANCE_CATALOG.map(testCase => {
    const reason = expectedProfileSkipReason(driver.profile, testCase);
    if (reason) {
      return {
        schemaVersion: 1,
        store: driver.name,
        caseId: testCase.id,
        status: 'skipped',
        requiredCapabilities: [...testCase.requires],
        reason,
        durationMs: 0,
      };
    }
    return {
      schemaVersion: 1,
      store: driver.name,
      caseId: testCase.id,
      status: 'failed',
      requiredCapabilities: [...testCase.requires],
      error: serialized,
      durationMs: 0,
    };
  });
}

export function createEntityConformanceDrivers(): readonly EntityConformanceDriver[] {
  return [
    createMemoryEntityConformanceDriver(),
    createSqliteEntityConformanceDriver(),
    createPostgresEntityConformanceDriver(process.env['TEST_POSTGRES_URL']),
    createMongoEntityConformanceDriver(process.env['TEST_MONGO_URL']),
    createRedisEntityConformanceDriver(process.env['TEST_REDIS_URL']),
  ];
}

export async function buildEntityConformanceReport(
  revision: string,
  drivers: readonly EntityConformanceDriver[] = createEntityConformanceDrivers(),
): Promise<EntityConformanceReport> {
  const driversByStore = new Map(drivers.map(driver => [driver.name, driver]));
  const results: EntityConformanceResult[] = [];

  for (const store of ENTITY_CONFORMANCE_STORES) {
    const driver = driversByStore.get(store);
    if (!driver) continue;
    try {
      results.push(...(await runEntityConformance(driver)));
    } catch (error) {
      results.push(...infrastructureFailureResults(driver, error));
    }
  }

  return {
    schemaVersion: 3,
    revision,
    profiles: ENTITY_BACKEND_PROFILES,
    results,
    transactionGuarantees: TRANSACTION_GUARANTEE_CATALOG.map(guarantee => ({
      ...guarantee,
      stores: ['sqlite', 'postgres'] as const,
      caseIds: [...guarantee.caseIds],
    })),
    concurrencyGuarantees: CONCURRENCY_GUARANTEE_CATALOG.map(guarantee => ({
      ...guarantee,
      stores: [...guarantee.stores],
      caseIds: [...guarantee.caseIds],
    })),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Validate release evidence independently of the runner.
 *
 * This rejects hand-authored skips because the only permitted skip is the exact
 * deterministic reason derived from an unsupported profile claim.
 */
export function validateEntityConformanceReport(
  report: EntityConformanceReport,
): readonly string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 3) {
    errors.push(`Report schemaVersion must be 3; received ${String(report.schemaVersion)}.`);
  }
  const profileStores = Object.keys(report.profiles);
  if (!sameStrings(profileStores, ENTITY_CONFORMANCE_STORES)) {
    errors.push(
      `Profiles must use stable store order ${ENTITY_CONFORMANCE_STORES.join(', ')}; received ${profileStores.join(', ')}.`,
    );
  }

  const drivers = new Set(report.results.map(result => result.store));
  for (const store of ENTITY_CONFORMANCE_STORES) {
    if (!drivers.has(store)) errors.push(`Missing conformance results for store '${store}'.`);
  }

  const catalogCapabilities = new Set(
    ENTITY_CONFORMANCE_CATALOG.flatMap(testCase => testCase.requires),
  );
  for (const capability of ENTITY_BACKEND_CAPABILITIES) {
    if (!catalogCapabilities.has(capability)) {
      errors.push(`Capability '${capability}' has no registered conformance case.`);
    }
  }
  for (const kind of ENTITY_OPERATION_KINDS) {
    if (!catalogCapabilities.has(`operation.${kind}`)) {
      errors.push(`Operation kind '${kind}' has no registered conformance case.`);
    }
  }

  const expectedResultCount = ENTITY_CONFORMANCE_STORES.length * ENTITY_CONFORMANCE_CATALOG.length;
  if (report.results.length !== expectedResultCount) {
    errors.push(
      `Expected ${expectedResultCount} ordered results; received ${report.results.length}.`,
    );
  }

  const passedEvidence = new Map<StoreType, Set<EntityBackendCapability>>(
    ENTITY_CONFORMANCE_STORES.map(store => [store, new Set<EntityBackendCapability>()]),
  );
  let resultIndex = 0;
  for (const store of ENTITY_CONFORMANCE_STORES) {
    const profile = report.profiles[store];
    if (!profile) continue;
    for (const testCase of ENTITY_CONFORMANCE_CATALOG) {
      const result = report.results[resultIndex];
      resultIndex += 1;
      if (!result) continue;
      if (result.store !== store || result.caseId !== testCase.id) {
        errors.push(
          `Result ${resultIndex - 1} must be ${store}:${testCase.id}; received ${result.store}:${result.caseId}.`,
        );
        continue;
      }
      if (!sameStrings(result.requiredCapabilities, testCase.requires)) {
        errors.push(`${store}:${testCase.id} changed the catalog capability requirements.`);
      }

      const expectedReason = expectedProfileSkipReason(profile, testCase);
      if (expectedReason) {
        if (result.status !== 'skipped') {
          errors.push(`${store}:${testCase.id} must be a profile-derived skip.`);
        } else if (result.reason !== expectedReason) {
          errors.push(`${store}:${testCase.id} has a hand-written or stale skip reason.`);
        }
        continue;
      }

      if (result.status === 'failed') {
        errors.push(
          `${store}:${testCase.id} failed: ${result.error?.name ?? 'Error'}: ${result.error?.message ?? 'Unknown failure'}`,
        );
        continue;
      }
      if (result.status === 'skipped') {
        errors.push(
          `${store}:${testCase.id} was skipped despite every requirement being supported.`,
        );
        continue;
      }
      const evidence = passedEvidence.get(store);
      for (const capability of testCase.requires) evidence?.add(capability);
    }
  }

  for (const store of ENTITY_CONFORMANCE_STORES) {
    const profile = report.profiles[store];
    if (!profile) continue;
    const evidence = passedEvidence.get(store);
    for (const capability of ENTITY_BACKEND_CAPABILITIES) {
      if (profile.capabilities[capability].status === 'supported' && !evidence?.has(capability)) {
        errors.push(`${store}:${capability} is supported without passing evidence.`);
      }
    }
  }

  const catalogCaseIds = new Set(ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id));
  if (report.transactionGuarantees.length !== TRANSACTION_GUARANTEE_CATALOG.length) {
    errors.push(
      `Expected ${TRANSACTION_GUARANTEE_CATALOG.length} transaction guarantees; received ${report.transactionGuarantees.length}.`,
    );
  }
  for (const [index, expected] of TRANSACTION_GUARANTEE_CATALOG.entries()) {
    const actual = report.transactionGuarantees[index];
    if (!actual || actual.id !== expected.id) {
      errors.push(`Transaction guarantee ${index} must be '${expected.id}'.`);
      continue;
    }
    if (!sameStrings(actual.stores, ['sqlite', 'postgres'])) {
      errors.push(`${actual.id} must require SQLite and PostgreSQL evidence.`);
    }
    if (!sameStrings(actual.caseIds, expected.caseIds)) {
      errors.push(`${actual.id} changed its required conformance cases.`);
    }
    for (const caseId of actual.caseIds) {
      if (!catalogCaseIds.has(caseId)) {
        errors.push(`${actual.id} references missing conformance case '${caseId}'.`);
        continue;
      }
      for (const store of actual.stores) {
        const result = report.results.find(
          candidate => candidate.store === store && candidate.caseId === caseId,
        );
        if (result?.status !== 'passed') {
          errors.push(`${store}:${caseId} must pass for transaction guarantee '${actual.id}'.`);
        }
      }
    }
  }

  if (report.concurrencyGuarantees.length !== CONCURRENCY_GUARANTEE_CATALOG.length) {
    errors.push(
      `Expected ${CONCURRENCY_GUARANTEE_CATALOG.length} concurrency guarantees; received ${report.concurrencyGuarantees.length}.`,
    );
  }
  for (const [index, expected] of CONCURRENCY_GUARANTEE_CATALOG.entries()) {
    const actual = report.concurrencyGuarantees[index];
    if (!actual || actual.id !== expected.id) {
      errors.push(`Concurrency guarantee ${index} must be '${expected.id}'.`);
      continue;
    }
    if (!sameStrings(actual.stores, expected.stores)) {
      errors.push(`${actual.id} changed its required evidence stores.`);
    }
    if (!sameStrings(actual.caseIds, expected.caseIds)) {
      errors.push(`${actual.id} changed its required conformance cases.`);
    }
    for (const caseId of actual.caseIds) {
      if (!catalogCaseIds.has(caseId)) {
        errors.push(`${actual.id} references missing conformance case '${caseId}'.`);
        continue;
      }
      for (const store of actual.stores) {
        const result = report.results.find(
          candidate => candidate.store === store && candidate.caseId === caseId,
        );
        if (result?.status !== 'passed') {
          errors.push(`${store}:${caseId} must pass for concurrency guarantee '${actual.id}'.`);
        }
      }
    }
  }

  return errors;
}

export function resolveGitRevision(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error('Unable to resolve the current git revision for entity conformance.');
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export async function main(): Promise<number> {
  const report = await buildEntityConformanceReport(resolveGitRevision());
  mkdirSync(resolve(ENTITY_CONFORMANCE_REPORT_PATH, '..'), { recursive: true });
  writeFileSync(ENTITY_CONFORMANCE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const errors = validateEntityConformanceReport(report);
  if (errors.length > 0) {
    console.error(`[entity-conformance] ${errors.length} evidence error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    console.error(`[entity-conformance] Report written to ${ENTITY_CONFORMANCE_REPORT_PATH}`);
    return 1;
  }

  console.log(
    `[entity-conformance] ${report.results.length} results across ${ENTITY_CONFORMANCE_STORES.length} stores are valid.`,
  );
  console.log(`[entity-conformance] Report written to ${ENTITY_CONFORMANCE_REPORT_PATH}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
