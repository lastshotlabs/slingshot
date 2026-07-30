import { createHash } from 'node:crypto';
import type { Backend } from './discover';
import type { MigrationStatus, PendingMigration } from './runner';

export type MigrationRisk = 'safe' | 'expand' | 'backfill' | 'contract' | 'destructive' | 'manual';

export interface MigrationCheck {
  readonly kind: 'migration-not-applied' | 'checksum' | 'sql-review';
  readonly description: string;
}

export interface MigrationOperation {
  readonly kind: 'sql' | 'mongo-script';
  readonly migrationId: string;
  readonly checksum: string;
}

export interface MigrationStep {
  readonly id: string;
  readonly phase: 'expand' | 'backfill' | 'contract';
  readonly risk: MigrationRisk;
  readonly description: string;
  readonly preconditions: readonly MigrationCheck[];
  readonly operation: MigrationOperation;
  readonly verification: readonly MigrationCheck[];
  readonly lockRisk: 'none' | 'brief' | 'table';
}

export interface MigrationPlanV2 {
  readonly formatVersion: 2;
  readonly migrationId: string;
  readonly backend: Backend;
  readonly fromChecksum: string;
  readonly toChecksum: string;
  readonly steps: readonly MigrationStep[];
  readonly approvalDigest: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function classifySql(sql: string): Pick<MigrationStep, 'phase' | 'risk' | 'lockRisk'> {
  const normalized = sql.toUpperCase();
  if (/\b(DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE)\b/.test(normalized)) {
    return { phase: 'contract', risk: 'destructive', lockRisk: 'table' };
  }
  if (/\b(ALTER\s+(TABLE|COLUMN)|SET\s+NOT\s+NULL)\b/.test(normalized)) {
    return { phase: 'contract', risk: 'contract', lockRisk: 'table' };
  }
  if (/\bUPDATE\b/.test(normalized)) {
    return { phase: 'backfill', risk: 'backfill', lockRisk: 'brief' };
  }
  return { phase: 'expand', risk: 'expand', lockRisk: 'brief' };
}

export function buildMigrationPlanV2(backend: Backend, status: MigrationStatus): MigrationPlanV2 {
  const steps = status.pending.map((migration, index) =>
    stepForPendingMigration(backend, migration, index),
  );
  const fromChecksum = sha256(
    status.applied.map(migration => `${migration.id}:${migration.checksum}`).join('\n'),
  );
  const toChecksum = sha256(
    [...status.applied, ...status.pending]
      .map(migration => `${migration.id}:${migration.checksum}`)
      .join('\n'),
  );
  const migrationId = status.pending.at(-1)?.id ?? status.applied.at(-1)?.id ?? 'current';
  const approvalRequired = steps.some(step =>
    ['contract', 'destructive', 'manual'].includes(step.risk),
  );
  const approvalDigest = approvalRequired
    ? sha256(
        JSON.stringify({
          formatVersion: 2,
          backend,
          migrationId,
          fromChecksum,
          toChecksum,
          steps,
        }),
      )
    : null;

  return {
    formatVersion: 2,
    migrationId,
    backend,
    fromChecksum,
    toChecksum,
    steps,
    approvalDigest,
  };
}

function stepForPendingMigration(
  backend: Backend,
  migration: PendingMigration,
  index: number,
): MigrationStep {
  const classification = classifySql(migration.sql);
  return {
    id: `${String(index + 1).padStart(4, '0')}:${migration.id}`,
    ...classification,
    description: `Apply migration ${migration.id}`,
    preconditions: [
      {
        kind: 'migration-not-applied',
        description: `${migration.id} is not already recorded in the migration ledger`,
      },
      {
        kind: 'checksum',
        description: `Migration content checksum is ${migration.checksum}`,
      },
    ],
    operation: {
      kind: backend === 'mongo' ? 'mongo-script' : 'sql',
      migrationId: migration.id,
      checksum: migration.checksum,
    },
    verification: [
      {
        kind: 'checksum',
        description: `${migration.id} is recorded with its immutable checksum`,
      },
    ],
  };
}

export function verifyMigrationPlanV2(plan: MigrationPlanV2, status: MigrationStatus): string[] {
  const failures: string[] = [];
  if (status.drift.length > 0) failures.push('applied migration checksum drift detected');
  if (status.missingFiles.length > 0) failures.push('applied migration files are missing');
  if (status.outOfOrder.length > 0) failures.push('pending migrations are out of order');
  if (plan.steps.some(step => step.preconditions.length === 0 || step.verification.length === 0)) {
    failures.push('one or more migration steps lack checks');
  }
  return failures;
}
