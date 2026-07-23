// Regression tests for the sqlite fieldUpdate executor's value binding.
//
// `op.fieldUpdate` bound `input[f]` raw. For a `json` field the input is an
// object/array, which bun:sqlite rejects ("SQLite query expected N values,
// received M") — so every fieldUpdate on a json column failed. The concrete
// casualty: slingshot-community's embed fan-out calls
// `Thread.attachEmbeds({ id }, { embeds })` from a bus subscriber whose catch
// is silent, so link unfurling looked wired but never persisted anything.
// The executor must serialize by declared field type, the same mapping the
// sqlite adapter's create/filter paths use.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { fieldUpdateSqlite } from '../../src/configDriven/operationExecutors/fieldUpdate';
import type { FieldUpdateOpConfig } from '../../src/configDriven/operations';

function makeDb() {
  const raw = new Database(':memory:');
  raw.run(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, embeds TEXT, tag_ids TEXT, pinned INTEGER, last_activity_at INTEGER)',
  );
  raw.run("INSERT INTO threads VALUES ('t1', NULL, NULL, 0, NULL)");
  const db = {
    run(sql: string, params?: unknown[]) {
      return raw.run(sql, ...((params ?? []) as never[]));
    },
    query<T>(sql: string) {
      return raw.query<T, never[]>(sql);
    },
  };
  return { raw, db };
}

const config = {
  name: 'Thread',
  fields: {
    id: { type: 'string', primary: true },
    embeds: { type: 'json' },
    tagIds: { type: 'string[]' },
    pinned: { type: 'boolean' },
    lastActivityAt: { type: 'date' },
  },
} as unknown as ResolvedEntityConfig;

const op: FieldUpdateOpConfig = {
  kind: 'fieldUpdate',
  match: { id: 'param:id' },
  set: ['embeds', 'tagIds', 'pinned', 'lastActivityAt'],
} as FieldUpdateOpConfig;

describe('fieldUpdateSqlite — bind serialization by field type', () => {
  test('json field binds a JSON string, not a raw object (attachEmbeds regression)', async () => {
    const { raw, db } = makeDb();
    const exec = fieldUpdateSqlite(
      op,
      config,
      db as never,
      'threads',
      () => {},
      r => r,
    );

    const embeds = [{ url: 'https://example.com', title: 'Example', type: 'link' }];
    await exec({ id: 't1' }, { embeds });

    const row = raw
      .query<{ embeds: string }, never[]>("SELECT embeds FROM threads WHERE id = 't1'")
      .get();
    expect(row?.embeds).toBe(JSON.stringify(embeds));
  });

  test('string[]/boolean/date fields bind sqlite-storable values', async () => {
    const { raw, db } = makeDb();
    const exec = fieldUpdateSqlite(
      op,
      config,
      db as never,
      'threads',
      () => {},
      r => r,
    );

    const when = new Date('2026-07-22T12:00:00Z');
    await exec({ id: 't1' }, { tagIds: ['a', 'b'], pinned: true, lastActivityAt: when });

    const row = raw
      .query<
        { tag_ids: string; pinned: number; last_activity_at: number },
        never[]
      >("SELECT tag_ids, pinned, last_activity_at FROM threads WHERE id = 't1'")
      .get();
    expect(row?.tag_ids).toBe(JSON.stringify(['a', 'b']));
    expect(row?.pinned).toBe(1);
    expect(row?.last_activity_at).toBe(when.getTime());
  });

  test('null clears a json field without stringifying', async () => {
    const { raw, db } = makeDb();
    raw.run("UPDATE threads SET embeds = '[]' WHERE id = 't1'");
    const exec = fieldUpdateSqlite(
      op,
      config,
      db as never,
      'threads',
      () => {},
      r => r,
    );

    await exec({ id: 't1' }, { embeds: null });

    const row = raw
      .query<{ embeds: string | null }, never[]>("SELECT embeds FROM threads WHERE id = 't1'")
      .get();
    expect(row?.embeds).toBeNull();
  });
});
