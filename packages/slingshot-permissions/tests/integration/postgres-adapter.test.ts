import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type PermissionGrant,
  attachPostgresPoolRuntime,
  createPostgresPoolRuntime,
} from '@lastshotlabs/slingshot-core';
import { createPermissionsPostgresAdapter } from '../../src/adapters/postgres';
import type { PgParam, PgRow, PoolClientLike, PoolLike } from '../../src/adapters/postgres';

// ---------------------------------------------------------------------------
// StoredRow
//
// Mirrors the pg column layout. All field values are subtypes of PgParam |
// string[], so StoredRow is structurally assignable to PgRow.
// ---------------------------------------------------------------------------

interface StoredRow {
  [key: string]: PgParam | string[]; // satisfies PgRow's index signature
  id: string;
  subject_id: string;
  subject_type: string;
  tenant_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  roles: string[]; // stored parsed (simulates JSONB return from pg)
  effect: string;
  granted_by: string;
  granted_at: Date;
  reason: string | null;
  expires_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
}

// ---------------------------------------------------------------------------
// Type guard for dynamic column lookup in applyFilter
// ---------------------------------------------------------------------------

const STORED_ROW_KEYS = new Set<string>([
  'id',
  'subject_id',
  'subject_type',
  'tenant_id',
  'resource_type',
  'resource_id',
  'roles',
  'effect',
  'granted_by',
  'granted_at',
  'reason',
  'expires_at',
  'revoked_by',
  'revoked_at',
]);

function isStoredRowKey(col: string): boolean {
  return STORED_ROW_KEYS.has(col);
}

// ---------------------------------------------------------------------------
// Filter helper — parses WHERE clause and filters StoredRow array
// ---------------------------------------------------------------------------

function applyFilter(rows: StoredRow[], sql: string, params: PgParam[]): StoredRow[] {
  const whereMatch = sql.match(/WHERE\s+(.+)$/is);
  if (!whereMatch) return rows;
  const parts = whereMatch[1].trim().split(/\s+AND\s+/i);
  return rows.filter(row => {
    for (const part of parts) {
      const eqMatch = part.match(/(\w+)\s*=\s*\$(\d+)/);
      const isNullMatch = part.match(/(\w+)\s+IS\s+NULL/i);
      const notNullMatch = part.match(/(\w+)\s+IS\s+NOT\s+NULL/i);
      if (eqMatch) {
        const col = eqMatch[1];
        if (!isStoredRowKey(col)) continue;
        const val = params[parseInt(eqMatch[2]) - 1];
        if (row[col] !== val) return false;
      } else if (isNullMatch) {
        const col = isNullMatch[1];
        if (!isStoredRowKey(col)) continue;
        if (row[col] !== null) return false;
      } else if (notNullMatch) {
        const col = notNullMatch[1];
        if (!isStoredRowKey(col)) continue;
        if (row[col] === null) return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// MockPool — implements PoolLike with an in-memory grant store
// ---------------------------------------------------------------------------

class MockPool implements PoolLike {
  readonly captured: Array<{ sql: string; params?: PgParam[] }> = [];
  private grants = new Map<string, StoredRow>();
  schemaVersion = 0;

  async connect(): Promise<PoolClientLike> {
    return {
      query: (sql, params) => this.query(sql, params),
      release() {},
    };
  }

  async query(
    sql: string,
    params?: PgParam[],
  ): Promise<{ rows: PgRow[]; rowCount: number | null }> {
    this.captured.push({ sql: sql.trim(), params });
    const s = sql.trim();

    // --- migration: version table ---
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (s.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (s.includes('_permission_schema_version')) {
      if (s.startsWith('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT COALESCE(MAX(version), 0) AS version')) {
        return { rows: [{ version: this.schemaVersion }], rowCount: 1 };
      }
      if (s === 'DELETE FROM _permission_schema_version') return { rows: [], rowCount: 1 };
      if (s.startsWith('INSERT INTO')) {
        const newVersion = params?.[0];
        if (typeof newVersion === 'number') this.schemaVersion = newVersion;
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_schema_version_singleton'))
        return { rows: [], rowCount: 0 };
      if (s.startsWith('UPDATE')) {
        const newVersion = params?.[0];
        if (typeof newVersion === 'number') this.schemaVersion = newVersion;
        return { rows: [], rowCount: 1 };
      }
    }
    // --- migration: schema DDL ---
    if (s.startsWith('CREATE TABLE IF NOT EXISTS permission_grants'))
      return { rows: [], rowCount: 0 };
    if (s.startsWith('CREATE INDEX IF NOT EXISTS')) return { rows: [], rowCount: 0 };

    // --- INSERT INTO permission_grants ---
    if (s.startsWith('INSERT INTO permission_grants')) {
      if (!params) throw new Error('MockPool: INSERT missing params');
      const [
        id,
        subjectId,
        subjectType,
        tenantId,
        resourceType,
        resourceId,
        rolesJson,
        effect,
        grantedBy,
        reason,
        expiresAt,
      ] = params;
      this.grants.set(String(id), {
        id: String(id),
        subject_id: String(subjectId),
        subject_type: String(subjectType),
        tenant_id: typeof tenantId === 'string' ? tenantId : null,
        resource_type: typeof resourceType === 'string' ? resourceType : null,
        resource_id: typeof resourceId === 'string' ? resourceId : null,
        roles: JSON.parse(String(rolesJson)), // parse JSON string → array, simulating JSONB round-trip
        effect: String(effect),
        granted_by: String(grantedBy),
        granted_at: new Date(),
        reason: typeof reason === 'string' ? reason : null,
        expires_at:
          expiresAt instanceof Date
            ? expiresAt
            : typeof expiresAt === 'string'
              ? new Date(expiresAt)
              : null,
        revoked_by: null,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    // --- UPDATE permission_grants SET revoked_by (revokeGrant) ---
    if (s.startsWith('UPDATE permission_grants SET revoked_by')) {
      if (!params) throw new Error('MockPool: UPDATE missing params');
      const [revokedBy, grantId, tenantScope] = params;
      const grant = this.grants.get(String(grantId));
      if (!grant || grant.revoked_at !== null) return { rows: [], rowCount: 0 };
      if (tenantScope !== undefined && grant.tenant_id !== tenantScope)
        return { rows: [], rowCount: 0 };
      grant.revoked_by = String(revokedBy);
      grant.revoked_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    // --- SELECT for listGrantHistory (no revocation/expiry filter) ---
    if (s === 'SELECT * FROM permission_grants WHERE subject_id = $1 AND subject_type = $2') {
      const filtered = applyFilter(Array.from(this.grants.values()), s, params ?? []);
      return { rows: filtered, rowCount: filtered.length };
    }

    // --- SELECT for getEffectiveGrantsForSubject (cascade OR query) ---
    if (
      s.includes('SELECT * FROM permission_grants') &&
      s.includes('tenant_id IS NULL AND resource_type IS NULL AND resource_id IS NULL')
    ) {
      if (!params) throw new Error('MockPool: cascade SELECT missing params');
      const subjectId = String(params[0]);
      const subjectType = String(params[1]);
      // Cascade scope params: $3=tenantId, $4=resourceType, $5=resourceId (each optional)
      const tenantId = params[2] !== undefined ? String(params[2]) : undefined;
      const resourceType = params[3] !== undefined ? String(params[3]) : undefined;
      const resourceId = params[4] !== undefined ? String(params[4]) : undefined;

      const now = new Date();
      const filtered = Array.from(this.grants.values()).filter(row => {
        if (row.subject_id !== subjectId || row.subject_type !== subjectType) return false;
        if (row.revoked_at !== null) return false;
        if (row.expires_at !== null && row.expires_at <= now) return false;
        // Global (level 4)
        if (row.tenant_id === null && row.resource_type === null && row.resource_id === null)
          return true;
        // Tenant-wide (level 3)
        if (
          tenantId !== undefined &&
          row.tenant_id === tenantId &&
          row.resource_type === null &&
          row.resource_id === null
        )
          return true;
        // Resource-type-wide (level 2)
        if (
          tenantId !== undefined &&
          resourceType !== undefined &&
          row.tenant_id === tenantId &&
          row.resource_type === resourceType &&
          row.resource_id === null
        )
          return true;
        // Specific resource (level 1)
        if (
          tenantId !== undefined &&
          resourceType !== undefined &&
          resourceId !== undefined &&
          row.tenant_id === tenantId &&
          row.resource_type === resourceType &&
          row.resource_id === resourceId
        )
          return true;
        return false;
      });
      return { rows: filtered, rowCount: filtered.length };
    }

    // --- SELECT * FROM permission_grants WHERE ... (getGrantsForSubject / listGrantsOnResource) ---
    if (s.startsWith('SELECT * FROM permission_grants WHERE')) {
      const now = new Date();
      // Pre-filter revoked and expired rows, mirroring the adapter's WHERE conditions.
      // Strip those clauses from the SQL before passing to applyFilter so they aren't double-processed.
      const active = Array.from(this.grants.values()).filter(
        row => row.revoked_at === null && (row.expires_at === null || row.expires_at > now),
      );
      const sqlForFilter = s
        .replace(/\s+AND\s+revoked_at\s+IS\s+NULL/gi, '')
        .replace(/\s+AND\s+\(expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*NOW\(\)\)/gi, '');
      const filtered = applyFilter(active, sqlForFilter, params ?? []);
      return { rows: filtered, rowCount: filtered.length };
    }

    // --- DELETE FROM permission_grants WHERE subject_id = $1 AND subject_type = $2 ---
    if (s.startsWith('DELETE FROM permission_grants')) {
      if (!params) throw new Error('MockPool: DELETE missing params');
      const [subjectId, subjectType] = params;
      let count = 0;
      for (const [id, row] of this.grants) {
        if (row.subject_id === subjectId && row.subject_type === subjectType) {
          this.grants.delete(id);
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    // --- TRUNCATE permission_grants CASCADE ---
    if (s.startsWith('TRUNCATE permission_grants')) {
      this.grants.clear();
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`MockPool: unhandled SQL — ${s.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GrantInput = Omit<PermissionGrant, 'id' | 'grantedAt'>;

function baseGrant(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    subjectId: 'user-1',
    subjectType: 'user',
    tenantId: null,
    resourceType: null,
    resourceId: null,
    roles: ['admin'],
    effect: 'allow',
    grantedBy: 'system',
    ...overrides,
  };
}

async function makeAdapter(pool: PoolLike) {
  return createPermissionsPostgresAdapter(pool);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Postgres permissions adapter — migrations', () => {
  test('runs v1 migration on a fresh database (version 0)', async () => {
    const pool = new MockPool(); // schemaVersion starts at 0
    await makeAdapter(pool);

    expect(pool.captured.some(q => q.sql === 'BEGIN')).toBe(true);
    expect(pool.captured.some(q => q.sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(
      pool.captured.some(q =>
        q.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_schema_version_singleton'),
      ),
    ).toBe(true);
    const versionUpdate = pool.captured.findLast(q =>
      q.sql.includes('UPDATE _permission_schema_version'),
    );
    expect(versionUpdate).toBeDefined();
    expect(versionUpdate.sql).toContain('UPDATE _permission_schema_version');
    expect(versionUpdate.params).toEqual([1]);
  });

  test('skips migrations when database is already at current version', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1; // already migrated
    await makeAdapter(pool);

    expect(pool.captured.some(q => q.sql === 'BEGIN')).toBe(true);
    expect(pool.captured.some(q => q.sql === 'COMMIT')).toBe(true);
    expect(pool.captured.some(q => q.sql.includes('UPDATE _permission_schema_version'))).toBe(
      false,
    );
    expect(
      pool.captured.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS permission_grants')),
    ).toBe(false);
  });

  test('canonicalizes duplicate version rows before applying migrations', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;

    await makeAdapter(pool);

    const maxVersionRead = pool.captured.find(q =>
      q.sql.includes('SELECT COALESCE(MAX(version), 0) AS version'),
    );
    const deleteRows = pool.captured.find(q => q.sql === 'DELETE FROM _permission_schema_version');
    const reinsert = pool.captured.find(
      q =>
        q.sql === 'INSERT INTO _permission_schema_version (version) VALUES ($1)' &&
        q.params?.[0] === 1,
    );

    expect(maxVersionRead).toBeDefined();
    expect(deleteRows).toBeDefined();
    expect(reinsert).toBeDefined();
  });

  test('fails closed when the database schema version is newer than this binary supports', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 2;

    await expect(makeAdapter(pool)).rejects.toThrow(
      'Database schema version 2 is newer than this binary supports (1)',
    );
    expect(pool.captured.some(q => q.sql === 'ROLLBACK')).toBe(true);
  });

  test('skips migrations when the pool runtime is configured as assume-ready', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 999;
    attachPostgresPoolRuntime(pool, createPostgresPoolRuntime({ migrationMode: 'assume-ready' }));

    await expect(makeAdapter(pool)).resolves.toBeDefined();
    expect(pool.captured).toHaveLength(0);
  });
});

describe('Postgres permissions adapter — createGrant', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('returns a UUID', async () => {
    const id = await adapter.createGrant(baseGrant());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('created grant is retrievable', async () => {
    const id = await adapter.createGrant(baseGrant({ roles: ['editor'] }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(id);
    expect(grants[0].roles).toEqual(['editor']);
    expect(grants[0].effect).toBe('allow');
    expect(grants[0].grantedAt).toBeInstanceOf(Date);
  });

  test('roles are returned as an array (JSONB — no JSON.parse needed)', async () => {
    // This test verifies F2: pg returns JSONB as a parsed array, not a JSON string.
    // MockPool stores roles as a parsed array after INSERT. rowToGrant must NOT call
    // JSON.parse on it, or it will throw / produce wrong results.
    await adapter.createGrant(baseGrant({ roles: ['admin', 'editor'] }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(Array.isArray(grants[0].roles)).toBe(true);
    expect(grants[0].roles).toEqual(['admin', 'editor']);
  });

  test('validation rejects empty roles', async () => {
    await expect(adapter.createGrant(baseGrant({ roles: [] }))).rejects.toThrow(
      'at least one role',
    );
  });

  test('stores reason and expiresAt', async () => {
    const future = new Date(Date.now() + 86_400_000);
    await adapter.createGrant(baseGrant({ reason: 'test reason', expiresAt: future }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants[0].reason).toBe('test reason');
    expect(grants[0].expiresAt).toBeInstanceOf(Date);
  });
});

describe('Postgres permissions adapter — revokeGrant', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('returns true and revoked grant is no longer returned', async () => {
    const id = await adapter.createGrant(baseGrant());
    const result = await adapter.revokeGrant(id, 'admin-1');
    expect(result).toBe(true);

    // Option A: revoked grants are filtered at the query level
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(0);
  });

  test('returns false for a non-existent grant', async () => {
    const result = await adapter.revokeGrant('nonexistent', 'admin-1');
    expect(result).toBe(false);
  });

  test('returns false for already-revoked grant', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const result = await adapter.revokeGrant(id, 'admin-2');
    expect(result).toBe(false);
  });

  test('tenantScope restricts revocation to matching tenant', async () => {
    const id = await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    const wrongTenant = await adapter.revokeGrant(id, 'admin', 'tenant-b');
    expect(wrongTenant).toBe(false);
    const rightTenant = await adapter.revokeGrant(id, 'admin', 'tenant-a');
    expect(rightTenant).toBe(true);
  });
});

describe('Postgres permissions adapter — getGrantsForSubject', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('filters by subjectId', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectId).toBe('user-1');
  });

  test('filters by subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const grants = await adapter.getGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectType).toBe('user');
  });

  test('filters by scope tenantId', async () => {
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-b' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, { tenantId: 'tenant-a' });
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBe('tenant-a');
  });

  test('returns empty array for unknown subject', async () => {
    const grants = await adapter.getGrantsForSubject('nobody');
    expect(grants).toEqual([]);
  });

  test('filters by scope resourceType', async () => {
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'p1' }));
    await adapter.createGrant(baseGrant({ resourceType: 'comment', resourceId: 'c1' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, {
      resourceType: 'post',
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].resourceType).toBe('post');
  });

  test('filters by scope resourceId', async () => {
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'p1' }));
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'p2' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, {
      resourceId: 'p1',
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].resourceId).toBe('p1');
  });
});

describe('Postgres permissions adapter — listGrantsOnResource', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('returns grants for a specific resource', async () => {
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'post-1' }));
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-2', resourceType: 'post', resourceId: 'post-1' }),
    );
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'post-2' }));
    const grants = await adapter.listGrantsOnResource('post', 'post-1');
    expect(grants).toHaveLength(2);
    expect(grants.every(g => g.resourceId === 'post-1')).toBe(true);
  });

  test('null tenantId uses IS NULL — returns only global grants', async () => {
    // This test verifies parity with the SQLite F1 fix.
    await adapter.createGrant(
      baseGrant({ resourceType: 'post', resourceId: 'post-1', tenantId: null }),
    );
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-2',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: 'tenant-a',
      }),
    );

    const grants = await adapter.listGrantsOnResource('post', 'post-1', null);
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBeNull();

    // Verify the generated SQL uses IS NULL, not = $3
    const selectQuery = pool.captured.find(
      q => q.sql.startsWith('SELECT * FROM permission_grants') && q.sql.includes('IS NULL'),
    );
    expect(selectQuery).toBeDefined();
    expect(selectQuery!.sql).toContain('tenant_id IS NULL');
    expect(selectQuery!.params).toHaveLength(2); // only resource_type and resource_id
  });

  test('string tenantId uses equality check', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'post', resourceId: 'post-1', tenantId: 'tenant-a' }),
    );
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-2',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: 'tenant-b',
      }),
    );
    const grants = await adapter.listGrantsOnResource('post', 'post-1', 'tenant-a');
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBe('tenant-a');
  });
});

describe('Postgres permissions adapter — getEffectiveGrantsForSubject', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('returns global grant with no scope', async () => {
    await adapter.createGrant(baseGrant({ tenantId: null, resourceType: null, resourceId: null }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
  });

  test('excludes tenant-scoped grant when no scope provided', async () => {
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });

  test('returns global + tenant-wide grants for tenant scope', async () => {
    await adapter.createGrant(baseGrant({ tenantId: null, roles: ['global'] }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a', roles: ['tenant'] }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-b', roles: ['other'] }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
    });
    expect(grants).toHaveLength(2);
    const roleSet = new Set(grants.flatMap(g => g.roles));
    expect(roleSet.has('global')).toBe(true);
    expect(roleSet.has('tenant')).toBe(true);
    expect(roleSet.has('other')).toBe(false);
  });

  test('cascade level 2: resource-type-wide grant applies when evaluating specific resource', async () => {
    await adapter.createGrant(
      baseGrant({
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: null,
        roles: ['editor'],
      }),
    );
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].roles).toEqual(['editor']);
  });

  test('cascade level 1: specific resource grant does not cover other resources', async () => {
    await adapter.createGrant(
      baseGrant({
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-42',
        roles: ['owner'],
      }),
    );
    const hit = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
    });
    expect(hit).toHaveLength(1);

    const miss = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-99',
    });
    expect(miss).toHaveLength(0);
  });

  test('revoked grants are excluded', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin');
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });
});

describe('Postgres permissions adapter — expiry filtering', () => {
  test('getGrantsForSubject excludes expired grants', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    await adapter.createGrant(
      baseGrant({ roles: ['active'], expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    // Directly insert an expired row into the store
    pool['grants'].set('expired-id', {
      id: 'expired-id',
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: null,
      resource_type: null,
      resource_id: null,
      roles: ['expired-role'],
      effect: 'allow',
      granted_by: 'system',
      granted_at: new Date(),
      reason: null,
      expires_at: new Date(Date.now() - 10_000),
      revoked_by: null,
      revoked_at: null,
    });

    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].roles).toEqual(['active']);
  });

  test('non-expiring grants are always returned', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);
    await adapter.createGrant(baseGrant()); // no expiresAt
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
  });
});

describe('Postgres permissions adapter — deleteAllGrantsForSubject', () => {
  test('hard-deletes all grants for a subject', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    await adapter.createGrant(baseGrant());
    await adapter.createGrant(baseGrant({ roles: ['editor'] }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));

    await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });

    const user1 = await adapter.getGrantsForSubject('user-1');
    expect(user1).toHaveLength(0);

    const user2 = await adapter.getGrantsForSubject('user-2');
    expect(user2).toHaveLength(1);
  });
});

describe('Postgres permissions adapter — listGrantHistory', () => {
  let pool: MockPool;
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;

  beforeEach(async () => {
    pool = new MockPool();
    pool.schemaVersion = 1;
    adapter = await makeAdapter(pool);
  });

  test('returns active grants', async () => {
    await adapter.createGrant(baseGrant({ roles: ['admin'] }));
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
  });

  test('includes revoked grants', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].revokedBy).toBe('admin-1');
    expect(history[0].revokedAt).toBeInstanceOf(Date);
  });

  test('includes expired grants', async () => {
    // Insert expired grant directly
    pool['grants'].set('expired-id', {
      id: 'expired-id',
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: null,
      resource_type: null,
      resource_id: null,
      roles: ['expired-role'],
      effect: 'allow',
      granted_by: 'system',
      granted_at: new Date(),
      reason: null,
      expires_at: new Date(Date.now() - 10_000),
      revoked_by: null,
      revoked_at: null,
    });
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].roles).toEqual(['expired-role']);
  });

  test('scopes to the given subjectId + subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].subjectId).toBe('user-1');
    expect(history[0].subjectType).toBe('user');
  });
});

describe('Postgres permissions adapter — row coercion errors', () => {
  // listGrantHistory has no revoked/expired pre-filtering, so bad rows reach rowToGrant
  test('str() throws when column is not a string', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    pool['grants'].set('bad-str', {
      id: 'bad-str',
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: null,
      resource_type: null,
      resource_id: null,
      roles: ['admin'],
      effect: 'allow',
      granted_by: 123 as never, // wrong type — should be string
      granted_at: new Date(),
      reason: null,
      expires_at: null,
      revoked_by: null,
      revoked_at: null,
    });

    await expect(adapter.listGrantHistory('user-1', 'user')).rejects.toThrow('expected string');
  });

  test('strOrNull() throws when column is neither string nor null', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    pool['grants'].set('bad-null', {
      id: 'bad-null',
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: 42 as never, // wrong type — should be string | null
      resource_type: null,
      resource_id: null,
      roles: ['admin'],
      effect: 'allow',
      granted_by: 'system',
      granted_at: new Date(),
      reason: null,
      expires_at: null,
      revoked_by: null,
      revoked_at: null,
    });

    await expect(adapter.listGrantHistory('user-1', 'user')).rejects.toThrow(
      'expected string | null',
    );
  });

  test('dateOrUndef() throws when column is neither Date nor null', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    pool['grants'].set('bad-date', {
      id: 'bad-date',
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: null,
      resource_type: null,
      resource_id: null,
      roles: ['admin'],
      effect: 'allow',
      granted_by: 'system',
      granted_at: new Date(),
      reason: null,
      expires_at: 'not-a-date' as never, // wrong type — should be Date | null
      revoked_by: null,
      revoked_at: null,
    });

    await expect(adapter.listGrantHistory('user-1', 'user')).rejects.toThrow(
      'expected Date | null',
    );
  });
});

describe('Postgres permissions adapter — clear', () => {
  test('removes all grants', async () => {
    const pool = new MockPool();
    pool.schemaVersion = 1;
    const adapter = await makeAdapter(pool);

    await adapter.createGrant(baseGrant());
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.clear();

    expect(await adapter.getGrantsForSubject('user-1')).toHaveLength(0);
    expect(await adapter.getGrantsForSubject('user-2')).toHaveLength(0);

    const truncateQuery = pool.captured.find(q => q.sql.startsWith('TRUNCATE permission_grants'));
    expect(truncateQuery).toBeDefined();
  });
});
