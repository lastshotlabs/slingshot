import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

// Simulate exactly what broke prod: a table created BEFORE a field was added,
// then the generated ensureTable() runs against it.
describe('sqlite schema drift', () => {
  test('an existing table gains a column added to the entity', () => {
    const db = new Database(':memory:');
    const table = 'game_game_sessions';

    // v1 schema — no display_epoch (this is what every live game had on disk)
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, status TEXT)`);
    db.run(`INSERT INTO ${table} (id, status) VALUES ('s1', 'lobby')`);

    // v2 entity now wants display_epoch. The old code stopped at CREATE TABLE
    // IF NOT EXISTS (a no-op) and the next write died with
    // "table game_game_sessions has no column named display_epoch".
    const before = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      r => r.name,
    );
    expect(before).not.toContain('display_epoch');

    // --- the reconciliation the generator now emits ---
    const existingCols = new Set(
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name),
    );
    const wantCols: [string, string][] = [
      ['id', 'TEXT PRIMARY KEY'],
      ['status', 'TEXT'],
      ['display_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, decl] of wantCols) {
      if (existingCols.size === 0 || existingCols.has(col)) continue;
      const addable = decl
        .replace(/PRIMARY KEY/gi, '')
        .replace(/\bUNIQUE\b/gi, '')
        .replace(/NOT NULL/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${addable}`);
    }
    // --------------------------------------------------

    const after = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      r => r.name,
    );
    expect(after).toContain('display_epoch');

    // the pre-existing row survived, and a write with the new column now works
    db.run(`UPDATE ${table} SET display_epoch = 3 WHERE id = 's1'`);
    const row = db.query(`SELECT * FROM ${table} WHERE id = 's1'`).get() as any;
    expect(row.status).toBe('lobby'); // data preserved
    expect(row.display_epoch).toBe(3); // new column usable
  });
});
