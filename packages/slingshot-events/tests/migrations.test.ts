import { describe, expect, test } from 'bun:test';
import { EventReliabilityTopologyError } from '../src';
import { POSTGRES_EVENT_RELIABILITY_MIGRATIONS } from '../src/migrations/postgres';
import { applyEventReliabilityMigrations } from '../src/migrations/runner';
import { SQLITE_EVENT_RELIABILITY_MIGRATIONS } from '../src/migrations/sqlite';

function createProvider(applied = new Map<number, string>()) {
  const statements: string[] = [];
  return {
    statements,
    provider: {
      async transaction(
        callback: (session: {
          applied: ReadonlyMap<number, string>;
          execute(statement: string): Promise<void>;
          record(version: number, checksum: string): Promise<void>;
        }) => Promise<void>,
      ) {
        await callback({
          applied,
          async execute(statement) {
            statements.push(statement);
          },
          async record(version, checksum) {
            applied.set(version, checksum);
          },
        });
      },
    },
  };
}

describe.each([
  ['postgres', POSTGRES_EVENT_RELIABILITY_MIGRATIONS],
  ['sqlite', SQLITE_EVENT_RELIABILITY_MIGRATIONS],
] as const)('%s event reliability migrations', (_store, migrations) => {
  test('declare exact outbox, inbox, indexes, and ledger', () => {
    const sql = migrations.flatMap(migration => migration.statements).join('\n');
    expect(sql).toContain('slingshot_event_reliability_migrations');
    expect(sql).toContain('slingshot_event_outbox');
    expect(sql).toContain('event_id');
    expect(sql).toContain('slingshot_event_inbox');
    expect(sql).toContain('PRIMARY KEY (consumer_name, event_id)');
    expect(sql).toContain('slingshot_event_replay_audit');
    expect(sql).toContain('slingshot_event_operator_audit');
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(8);
  });

  test('is idempotent through the checksum ledger', async () => {
    const fixture = createProvider();
    await applyEventReliabilityMigrations(fixture.provider, migrations);
    const firstCount = fixture.statements.length;
    await applyEventReliabilityMigrations(fixture.provider, migrations);
    expect(fixture.statements).toHaveLength(firstCount);
  });

  test('upgrades a version-1 fixture without replaying old-schema DDL', async () => {
    const fixture = createProvider(new Map([[1, migrations[0]!.checksum]]));
    await applyEventReliabilityMigrations(fixture.provider, migrations);

    expect(fixture.statements).toEqual(
      migrations.slice(1).flatMap(migration => migration.statements),
    );
  });

  test('rejects a changed checksum for an applied version', async () => {
    const fixture = createProvider(new Map([[1, 'different']]));
    await expect(
      applyEventReliabilityMigrations(fixture.provider, migrations),
    ).rejects.toBeInstanceOf(EventReliabilityTopologyError);
  });
});
