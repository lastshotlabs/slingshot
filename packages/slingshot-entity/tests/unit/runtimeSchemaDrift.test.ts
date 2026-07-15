/**
 * The CONFIG-DRIVEN runtime adapters must reconcile schema drift, exactly like
 * the generated-code path already does.
 *
 * ## The gap this pins
 *
 * `tests/sqliteSchemaDrift.test.ts` proves the GENERATOR emits additive column
 * reconciliation (`PRAGMA table_info` diff + `ALTER TABLE ADD COLUMN`) — the
 * `host_absent_since` lesson, where an entity gained a field, every deployed
 * table predated it, and every write against the new column 500'd silently in
 * production for days.
 *
 * But every game on this platform reaches SQLite through the *config-driven*
 * runtime adapter (`createSqliteEntityAdapter`, via `createEntityFactories`),
 * and that path stopped at `CREATE TABLE IF NOT EXISTS` — a no-op on an
 * existing table. So adding a field to a framework entity (GameSession's
 * `stagedRules`) meant: fresh installs fine, every EXISTING deployment broken
 * on the first write that touches the new column.
 *
 * The rule: table bootstrap is additive-reconciling everywhere. We never drop
 * or retype a column; we add what the entity has and the table lacks.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createSqliteEntityAdapter } from '../../src/configDriven/sqliteAdapter';
import { defineEntity, field } from '../../src/defineEntity';

interface SessionRow {
  id: string;
  status: string;
  stagedRules?: Record<string, unknown> | null;
}

function sessionEntity(withStagedRules: boolean) {
  return defineEntity('GameSession', {
    namespace: 'game',
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      status: field.string({ default: 'lobby' }),
      ...(withStagedRules ? { stagedRules: field.json({ optional: true }) } : {}),
    },
  } as never);
}

function adapterFor(db: Database, withStagedRules: boolean) {
  const entity = sessionEntity(withStagedRules);
  return createSqliteEntityAdapter<SessionRow, Partial<SessionRow>, Partial<SessionRow>>(
    db as never,
    ((entity as { config?: never }).config ?? entity) as never,
  );
}

describe('config-driven sqlite adapter — schema drift', () => {
  test('an EXISTING table gains a column added to the entity, data preserved', async () => {
    const db = new Database(':memory:');

    // v1 of the app: table created without staged_rules, and a live row in it
    // (this is every deployed game's game_game_sessions on disk today).
    const v1 = adapterFor(db, false);
    const created = await v1.create({ status: 'playing' } as never);
    const cols = () =>
      (db.query(`PRAGMA table_info("game_game_sessions")`).all() as { name: string }[]).map(
        r => r.name,
      );
    expect(cols()).not.toContain('staged_rules');

    // v2 of the app boots against the SAME database with the field added.
    const v2 = adapterFor(db, true);

    // The write that died in production with "no such column": persisting a
    // staged rules patch onto the pre-existing session row.
    const updated = await v2.update(created.id, {
      stagedRules: { timers: { answerSeconds: 10 } },
    } as never);
    expect(updated).toBeTruthy();
    expect(cols()).toContain('staged_rules');

    // Pre-existing data survived, and the new column round-trips.
    const found = (await v2.getById(created.id)) as SessionRow;
    expect(found.status).toBe('playing');
    expect(found.stagedRules).toEqual({ timers: { answerSeconds: 10 } });
  });
});
