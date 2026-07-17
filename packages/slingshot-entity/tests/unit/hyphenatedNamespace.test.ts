/**
 * An entity in a hyphenated namespace must round-trip.
 *
 * ## The bug this pins
 *
 * `_storageName` is `${namespace}_${plural}`, and a namespace is free-form. Every
 * in-tree package happened to use a bare word — `chat`, `assets`, `community` — so
 * the unquoted interpolation into `CREATE TABLE ${table}` worked by luck.
 *
 * Then `slingshot-ai` used its own package name as its namespace and produced the
 * table `slingshot-ai_aiUsageRecords`. SQLite parsed the hyphen as a minus
 * operator: **`near "-": syntax error`** — on CREATE, and on every write after it.
 *
 * That table is the AI **spend ledger**, and the pre-flight budget guard hydrates
 * from it at boot: the guard whose entire purpose is to stop a runaway LLM loop
 * spending real money, and which was deliberately built to survive a crash-loop.
 * A ledger that silently fails to persist hands the app a fresh budget on every
 * restart — exactly the case it existed to prevent.
 *
 * Every package on this platform is named `slingshot-something`. A hyphenated
 * namespace is the norm, not an edge case; it had simply never been used.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { quoteSqliteIdent } from '../../src/configDriven/fieldUtils';
import { createSqliteEntityAdapter } from '../../src/configDriven/sqliteAdapter';
import { defineEntity, field } from '../../src/defineEntity';

function adapterFor(namespace: string) {
  const entity = defineEntity('UsageRecord', {
    namespace,
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      provider: field.string(),
      costUsd: field.number({ default: 0 }),
      createdAt: field.date({ default: 'now' }),
    },
    indexes: [{ fields: ['provider'], unique: false }],
  } as never);

  const db = new Database(':memory:');
  return createSqliteEntityAdapter<
    { id: string; provider: string; costUsd: number },
    { provider: string; costUsd: number },
    { costUsd?: number }
  >(db as never, (entity as unknown as { config: never }).config ?? (entity as never));
}

describe('quoteSqliteIdent', () => {
  test('quotes a hyphenated identifier', () => {
    expect(quoteSqliteIdent('slingshot-ai_aiUsageRecords')).toBe('"slingshot-ai_aiUsageRecords"');
  });

  test('escapes an embedded double quote rather than breaking out of it', () => {
    expect(quoteSqliteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe('an entity in a HYPHENATED namespace', () => {
  test('creates its table, writes, and reads back — the ledger persists', async () => {
    const usage = adapterFor('slingshot-ai');

    const created = await usage.create({ provider: 'grok', costUsd: 0.0117 } as never);
    expect(created.provider).toBe('grok');

    const found = await usage.getById((created as { id: string }).id);
    expect(found).toBeTruthy();
    expect((found as { costUsd: number }).costUsd).toBeCloseTo(0.0117);

    // The spend guard reads the ledger back at boot. If this list is empty, the
    // budget silently resets on every restart.
    const all = await usage.list({});
    expect(
      (all as { items?: unknown[] }).items?.length ?? (all as unknown as unknown[]).length,
    ).toBe(1);
  });

  test('a bare namespace still works (no regression)', async () => {
    const usage = adapterFor('ai');
    const created = await usage.create({ provider: 'deepseek', costUsd: 0.0004 } as never);
    const found = await usage.getById((created as { id: string }).id);
    expect((found as { provider: string }).provider).toBe('deepseek');
  });
});
