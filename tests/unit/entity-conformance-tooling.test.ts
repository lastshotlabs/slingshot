import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  ENTITY_BACKEND_CAPABILITIES,
  ENTITY_OPERATION_KINDS,
  type EntityBackendProfile,
  type StoreType,
} from '@lastshotlabs/slingshot-core';
import { ENTITY_BACKEND_PROFILES } from '../../packages/slingshot-entity/src/configDriven/backendProfiles';
import { ENTITY_CONFORMANCE_CATALOG } from '../../packages/slingshot-entity/src/testing/catalog';
import type { EntityConformanceResult } from '../../packages/slingshot-entity/src/testing/conformance';
import {
  ENTITY_CONFORMANCE_STORES,
  type EntityConformanceReport,
  expectedProfileSkipReason,
  validateEntityConformanceReport,
} from '../../scripts/entity-conformance-report';
import {
  ENTITY_SUPPORT_MATRIX_PATH,
  renderEntitySupportMatrix,
} from '../../scripts/generate-entity-support-matrix';

function passingReport(): EntityConformanceReport {
  const results: EntityConformanceResult[] = [];
  for (const store of ENTITY_CONFORMANCE_STORES) {
    const profile = ENTITY_BACKEND_PROFILES[store];
    for (const testCase of ENTITY_CONFORMANCE_CATALOG) {
      const reason = expectedProfileSkipReason(profile, testCase);
      results.push(
        reason
          ? {
              schemaVersion: 1,
              store,
              caseId: testCase.id,
              status: 'skipped',
              requiredCapabilities: [...testCase.requires],
              reason,
              durationMs: 0,
            }
          : {
              schemaVersion: 1,
              store,
              caseId: testCase.id,
              status: 'passed',
              requiredCapabilities: [...testCase.requires],
              durationMs: 1,
            },
      );
    }
  }
  return {
    schemaVersion: 1,
    revision: 'test-revision',
    profiles: ENTITY_BACKEND_PROFILES,
    results,
  };
}

function replaceResult(
  report: EntityConformanceReport,
  store: StoreType,
  caseId: string,
  replacement: EntityConformanceResult,
): EntityConformanceReport {
  return {
    ...report,
    results: report.results.map(result =>
      result.store === store && result.caseId === caseId ? replacement : result,
    ),
  };
}

describe('entity conformance evidence tooling', () => {
  test('accepts complete profile-derived evidence in stable order', () => {
    const report = passingReport();
    expect(validateEntityConformanceReport(report)).toEqual([]);
    expect(Object.keys(report.profiles)).toEqual([...ENTITY_CONFORMANCE_STORES]);
    expect(report.results).toHaveLength(
      ENTITY_CONFORMANCE_STORES.length * ENTITY_CONFORMANCE_CATALOG.length,
    );
  });

  test('rejects selected failures and hand-written skips', () => {
    const report = passingReport();
    const selected = report.results.find(
      result => result.store === 'postgres' && result.status === 'passed',
    );
    if (!selected) throw new Error('Expected a selected PostgreSQL case');

    const failure = replaceResult(report, 'postgres', selected.caseId, {
      ...selected,
      status: 'failed',
      error: { name: 'Error', message: 'synthetic failure' },
    });
    expect(validateEntityConformanceReport(failure).join('\n')).toContain('synthetic failure');

    const manualSkip = replaceResult(report, 'postgres', selected.caseId, {
      ...selected,
      status: 'skipped',
      reason: 'manual',
      durationMs: 0,
    });
    const manualErrors = validateEntityConformanceReport(manualSkip).join('\n');
    expect(manualErrors).toContain('skipped despite every requirement being supported');
  });

  test('covers every capability and all 19 operation kinds', () => {
    const requirements = new Set(ENTITY_CONFORMANCE_CATALOG.flatMap(item => item.requires));
    expect(ENTITY_OPERATION_KINDS).toHaveLength(19);
    for (const kind of ENTITY_OPERATION_KINDS) {
      expect(requirements.has(`operation.${kind}`)).toBe(true);
    }
    for (const capability of ENTITY_BACKEND_CAPABILITIES) {
      expect(requirements.has(capability)).toBe(true);
    }
  });

  test('renders the committed five-store matrix deterministically', async () => {
    const first = await renderEntitySupportMatrix();
    const second = await renderEntitySupportMatrix();
    expect(first).toBe(second);
    expect(readFileSync(ENTITY_SUPPORT_MATRIX_PATH, 'utf8')).toBe(first);
    expect(first).toMatch(
      /\| Capability\s+\| Memory\s+\| Sqlite\s+\| Postgres\s+\| Mongo\s+\| Redis\s+\|/u,
    );
    expect(first).toContain('Memory is a development/test store');
    for (const kind of ENTITY_OPERATION_KINDS) {
      expect(first).toContain(`operation.${kind}`);
    }
  });

  test('detects a supported profile claim without selectable evidence', () => {
    const report = passingReport();
    const redis = report.profiles.redis;
    const profiles = {
      ...report.profiles,
      redis: {
        ...redis,
        capabilities: {
          ...redis.capabilities,
          'operation.increment': { status: 'supported' as const },
        },
      },
    } satisfies Record<StoreType, EntityBackendProfile>;

    expect(
      validateEntityConformanceReport({
        ...report,
        profiles,
      }).join('\n'),
    ).toContain('redis:operation.increment is supported without passing evidence');
  });
});
