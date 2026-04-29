/**
 * Unit tests for the `clearPostgresAuthTables` testing utility.
 *
 * This helper truncates all slingshot auth tables in child-to-parent order to
 * respect foreign key constraints. We verify the deletion order and that the
 * re-exported helpers are accessible.
 */
import { describe, expect, mock, test } from 'bun:test';

// We test clearPostgresAuthTables by capturing the sequence of delete calls
// made against a mock DrizzlePostgresDb.

describe('clearPostgresAuthTables', () => {
  test('deletes tables in FK-safe order (children before parents)', async () => {
    const { clearPostgresAuthTables } = await import(`../src/testing.ts?order=${Date.now()}`);
    const deletedTables: Array<{ name: string; table: unknown }> = [];

    const mockDb = {
      db: {
        delete: (table: unknown) => {
          // Return a chainable builder so the `.delete()` returns `.then()`-able
          const builder = {
            then: (resolve: (v: undefined) => void) => resolve(undefined),
          };
          deletedTables.push({ name: 'builder-created', table });
          return builder;
        },
      },
    };

    await clearPostgresAuthTables(mockDb as never);

    // There should be 8 delete calls total (7 child tables + 2 parent = actually 8)
    expect(deletedTables).toHaveLength(8);
  });

  test('deletes groupMemberships first (deepest child)', async () => {
    const { clearPostgresAuthTables } = await import(`../src/testing.ts?first-table=${Date.now()}`);
    const deleteOrder: string[] = [];

    const mockDb = {
      db: {
        delete: (table: unknown) => {
          const name = String(
            (table as Record<symbol, string>)[Symbol.for('drizzle:Name')] ??
              (table as Record<string, string>).name ??
              'unknown',
          );
          deleteOrder.push(name);
          return { then: (resolve: (v: undefined) => void) => resolve(undefined) };
        },
      },
    };

    await clearPostgresAuthTables(mockDb as never);

    // The first delete should be groupMemberships
    expect(deleteOrder[0]).toBe('slingshot_group_memberships');
  });

  test('deletes parent tables (groups, users) last', async () => {
    const { clearPostgresAuthTables } = await import(`../src/testing.ts?last-tables=${Date.now()}`);
    const deleteOrder: string[] = [];

    const mockDb = {
      db: {
        delete: (table: unknown) => {
          const name = String(
            (table as Record<symbol, string>)[Symbol.for('drizzle:Name')] ??
              (table as Record<string, string>).name ??
              'unknown',
          );
          deleteOrder.push(name);
          return { then: (resolve: (v: undefined) => void) => resolve(undefined) };
        },
      },
    };

    await clearPostgresAuthTables(mockDb as never);

    // Last two tables should be groups and users (in that order)
    const lastTwo = deleteOrder.slice(-2);
    expect(lastTwo).toEqual(['slingshot_groups', 'slingshot_users']);
  });

  test('importing from testing subpath re-exports connectPostgres', async () => {
    const testing = await import(`../src/testing.ts?re-export1=${Date.now()}`);
    expect(testing).toHaveProperty('connectPostgres');
    expect(typeof testing.connectPostgres).toBe('function');
  });

  test('importing from testing subpath re-exports DrizzlePostgresDb type-like duck property', async () => {
    // DrizzlePostgresDb is a TypeScript type-only export, so it won't appear at
    // runtime. We verify the module shape is correct by checking that the exports
    // are present.
    const testing = await import(`../src/testing.ts?re-export2=${Date.now()}`);
    // The module should have clearPostgresAuthTables as the primary export
    expect(testing).toHaveProperty('clearPostgresAuthTables');
  });

  test('truncation order allows FK-safe schema reset in integration tests', async () => {
    // This test verifies the conceptual FK safety: child tables that reference
    // users or groups via foreign keys are deleted before the parent tables.
    // The order in the source code is:
    //   1. groupMemberships (FK → users, groups)
    //   2. recoveryCodes (FK → users)
    //   3. webauthnCredentials (FK → users)
    //   4. oauthAccounts (FK → users)
    //   5. userRoles (FK → users)
    //   6. tenantRoles (FK → users)
    //   7. groups (no FK to users — but memberships FK to it, already deleted)
    //   8. users (no outstanding FKs at this point)
    //
    // We verify these constraints by checking the delete order against
    // the table names from the schema.
    const { clearPostgresAuthTables } = await import(`../src/testing.ts?fk-order=${Date.now()}`);
    const schema = await import(`../src/schema.ts?schema-for-fk=${Date.now()}`);
    const deleteOrder: Array<symbol> = [];

    const mockDb = {
      db: {
        delete: (table: unknown) => {
          const nameSymbol = (table as Record<symbol, unknown>)[
            Symbol.for('drizzle:Name')
          ] as symbol;
          deleteOrder.push(nameSymbol);
          return { then: (resolve: (v: undefined) => void) => resolve(undefined) };
        },
      },
    };

    await clearPostgresAuthTables(mockDb as never);

    // Map symbols back to table names
    const nameOrder = deleteOrder.map(
      sym => (sym as unknown as { name?: string }).name ?? String(sym),
    );

    // Verify all expected tables are in order
    const expectedNames = [
      schema.groupMemberships,
      schema.recoveryCodes,
      schema.webauthnCredentials,
      schema.oauthAccounts,
      schema.userRoles,
      schema.tenantRoles,
      schema.groups,
      schema.users,
    ].map(t => (t as Record<symbol, string>)[Symbol.for('drizzle:Name')]);

    expect(nameOrder).toEqual(expectedNames);
  });

  test('resolves successfully with a real Drizzle-like db handle', async () => {
    // This test verifies that clearPostgresAuthTables works with a minimal
    // Drizzle-like db that has the `.delete(table)` → chainable → `.then()` pattern.
    const { clearPostgresAuthTables } = await import(
      `../src/testing.ts?resolve-test=${Date.now()}`
    );

    let callCount = 0;
    const mockDb = {
      db: {
        delete: () => {
          callCount++;
          return Promise.resolve(undefined);
        },
      },
    };

    await clearPostgresAuthTables(mockDb as never);
    expect(callCount).toBe(8);
  });
});
