import { describe, expect, test } from 'bun:test';
import { buildMigrationPlanV2, verifyMigrationPlanV2 } from '../../src/cli/lib/migrate/planV2';
import type { MigrationStatus } from '../../src/cli/lib/migrate/runner';

function status(sql: string): MigrationStatus {
  return {
    applied: [],
    pending: [
      {
        id: '20260730000000_change',
        filename: '20260730000000_change.sql',
        path: '/tmp/20260730000000_change.sql',
        sql,
        checksum: 'a'.repeat(64),
      },
    ],
    drift: [],
    missingFiles: [],
    outOfOrder: [],
  };
}

describe('migration plan v2', () => {
  test('is deterministic and gives every step checks', () => {
    const first = buildMigrationPlanV2('sqlite', status('CREATE TABLE widgets (id TEXT);'));
    const second = buildMigrationPlanV2('sqlite', status('CREATE TABLE widgets (id TEXT);'));
    expect(first).toEqual(second);
    expect(first.formatVersion).toBe(2);
    expect(first.steps[0]?.preconditions.length).toBeGreaterThan(0);
    expect(first.steps[0]?.verification.length).toBeGreaterThan(0);
    expect(first.approvalDigest).toBeNull();
    expect(verifyMigrationPlanV2(first, status('CREATE TABLE widgets (id TEXT);'))).toEqual([]);
  });

  test('requires a stable approval digest for destructive work', () => {
    const plan = buildMigrationPlanV2('postgres', status('DROP TABLE widgets;'));
    expect(plan.steps[0]).toMatchObject({
      phase: 'contract',
      risk: 'destructive',
      lockRisk: 'table',
    });
    expect(plan.approvalDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('fails verification for history and ordering drift', () => {
    const broken = status('CREATE TABLE widgets (id TEXT);');
    broken.drift.push({
      id: 'old',
      storedChecksum: 'a',
      currentChecksum: 'b',
    });
    broken.missingFiles.push('missing');
    broken.outOfOrder.push('older');
    expect(verifyMigrationPlanV2(buildMigrationPlanV2('sqlite', broken), broken)).toHaveLength(3);
  });
});
