/**
 * Regression coverage for two destructive SQLite adapter behaviours reported
 * against published Slingshot 0.2.0:
 *
 * - #3 `create()` used `INSERT OR REPLACE`, so a second row conflicting on a
 *   unique column silently DELETEd the first and orphaned its children. A
 *   uniqueness conflict must fail (409), matching the memory adapter.
 * - #4 `update()` read the row back through the guard `where`, so a guarded
 *   CAS write that changed the guarded column returned `null` — success was
 *   indistinguishable from a lost guard. It must read back by primary key and
 *   return `null` only when the guarded UPDATE changed zero rows.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createSqliteEntityAdapter } from '../../src/configDriven/sqliteAdapter';
import { defineEntity, field } from '../../src/defineEntity';

type Doc = { id: string; slug: string; version: number };

function adapter() {
  const entity = defineEntity('Doc', {
    namespace: 'test',
    fields: {
      id: field.string({ primary: true }),
      slug: field.string(),
      version: field.number({ default: 1 }),
    },
    indexes: [{ fields: ['slug'], unique: true }],
  } as never);

  const db = new Database(':memory:');
  return createSqliteEntityAdapter<Doc, Doc, Partial<Doc>>(
    db as never,
    (entity as unknown as { config: never }).config ?? (entity as never),
  );
}

describe('SQLite create() — unique conflicts fail instead of replacing (#3)', () => {
  test('a second row conflicting on a unique column is rejected, first row survives', async () => {
    const a = adapter();
    await a.create({ id: 'A', slug: 'same', version: 1 });

    let thrown: unknown;
    try {
      await a.create({ id: 'B', slug: 'same', version: 1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('UNIQUE_VIOLATION');

    // Row A must still be there — NOT deleted-and-replaced by B.
    expect(await a.getById('A')).toMatchObject({ id: 'A', slug: 'same' });
    expect(await a.getById('B')).toBeNull();
  });

  test('a primary-key conflict is also rejected', async () => {
    const a = adapter();
    await a.create({ id: 'A', slug: 'one', version: 1 });
    await expect(a.create({ id: 'A', slug: 'two', version: 1 })).rejects.toBeInstanceOf(HttpError);
    // Original row is intact.
    expect(await a.getById('A')).toMatchObject({ slug: 'one' });
  });
});

describe('SQLite update() — guarded CAS read-back by primary key (#4)', () => {
  test('changing the guarded column returns the updated row, not null', async () => {
    const a = adapter();
    await a.create({ id: 'A', slug: 'a', version: 1 });

    const updated = await a.update('A', { version: 2 } as Partial<Doc>, { version: 1 });

    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({ id: 'A', version: 2 });
    expect(await a.getById('A')).toMatchObject({ version: 2 });
  });

  test('a lost guard (wrong expected value) still returns null', async () => {
    const a = adapter();
    await a.create({ id: 'A', slug: 'a', version: 5 });

    const updated = await a.update('A', { version: 6 } as Partial<Doc>, { version: 1 });

    expect(updated).toBeNull();
    // The row was not touched.
    expect(await a.getById('A')).toMatchObject({ version: 5 });
  });
});
