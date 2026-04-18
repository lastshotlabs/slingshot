/**
 * Adapter parity tests — Memory + SQLite.
 *
 * Runs the shared parity suite against both in-process adapters to verify
 * behavioral equivalence without requiring Docker.
 */
import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { createSqliteAuthAdapter } from '@auth/adapters/sqliteAuth';
import { Database } from 'bun:sqlite';
import { beforeEach } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { adapterParitySuite } from '../shared/adapter-parity';

// ---------------------------------------------------------------------------
// Memory adapter
// ---------------------------------------------------------------------------

let memoryAdapter: AuthAdapter;

beforeEach(() => {
  memoryAdapter = createMemoryAuthAdapter();
});

adapterParitySuite({
  name: 'memory',
  getAdapter: () => memoryAdapter,
});

// ---------------------------------------------------------------------------
// SQLite adapter (in-memory)
// ---------------------------------------------------------------------------

let sqliteAdapter: AuthAdapter;

beforeEach(() => {
  // Fresh in-memory DB per test — no cleanup needed
  const result = createSqliteAuthAdapter(new Database(':memory:'), Bun.password);
  sqliteAdapter = result.adapter;
});

adapterParitySuite({
  name: 'sqlite',
  getAdapter: () => sqliteAdapter,
});
