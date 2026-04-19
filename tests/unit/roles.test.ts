import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import {
  addTenantRole,
  addUserRole,
  getTenantRoles,
  removeTenantRole,
  removeUserRole,
  setTenantRoles,
  setUserRoles,
} from '@auth/lib/roles';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

let adapter: ReturnType<typeof createMemoryAuthAdapter>;
beforeEach(async () => {
  await createTestApp();
  adapter = createMemoryAuthAdapter();
});

async function createUser(email = 'roles@example.com') {
  const user = await adapter.create(email, await Bun.password.hash('password123'));
  return user.id;
}

// ---------------------------------------------------------------------------
// App-wide roles
// ---------------------------------------------------------------------------

describe('setUserRoles', () => {
  test('sets roles on a user', async () => {
    const userId = await createUser();
    await setUserRoles(userId, ['admin', 'editor'], undefined, adapter);
    const roles = await adapter.getRoles!(userId);
    expect(roles).toEqual(['admin', 'editor']);
  });

  test('replaces existing roles', async () => {
    const userId = await createUser();
    await setUserRoles(userId, ['admin'], undefined, adapter);
    await setUserRoles(userId, ['editor'], undefined, adapter);
    const roles = await adapter.getRoles!(userId);
    expect(roles).toEqual(['editor']);
  });
});

describe('addUserRole', () => {
  test('adds a role', async () => {
    const userId = await createUser();
    await addUserRole(userId, 'admin', undefined, adapter);
    const roles = await adapter.getRoles!(userId);
    expect(roles).toContain('admin');
  });
});

describe('removeUserRole', () => {
  test('removes a role', async () => {
    const userId = await createUser();
    await addUserRole(userId, 'admin', undefined, adapter);
    await addUserRole(userId, 'editor', undefined, adapter);
    await removeUserRole(userId, 'admin', undefined, adapter);
    const roles = await adapter.getRoles!(userId);
    expect(roles).not.toContain('admin');
    expect(roles).toContain('editor');
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped roles
// ---------------------------------------------------------------------------

describe('getTenantRoles', () => {
  test('returns roles for a userId+tenantId pair', async () => {
    const userId = await createUser();
    await setTenantRoles(userId, 'tenant-1', ['admin'], undefined, adapter);
    const roles = await getTenantRoles(userId, 'tenant-1', adapter);
    expect(roles).toEqual(['admin']);
  });

  test('returns empty array for unknown tenant', async () => {
    const userId = await createUser();
    const roles = await getTenantRoles(userId, 'nonexistent', adapter);
    expect(roles).toEqual([]);
  });
});

describe('setTenantRoles', () => {
  test('replaces tenant roles', async () => {
    const userId = await createUser();
    await setTenantRoles(userId, 't1', ['admin'], undefined, adapter);
    await setTenantRoles(userId, 't1', ['viewer'], undefined, adapter);
    const roles = await getTenantRoles(userId, 't1', adapter);
    expect(roles).toEqual(['viewer']);
  });
});

describe('addTenantRole', () => {
  test('adds a single tenant role', async () => {
    const userId = await createUser();
    await addTenantRole(userId, 't1', 'editor', undefined, adapter);
    const roles = await getTenantRoles(userId, 't1', adapter);
    expect(roles).toContain('editor');
  });
});

describe('removeTenantRole', () => {
  test('removes a single tenant role', async () => {
    const userId = await createUser();
    await setTenantRoles(userId, 't1', ['admin', 'editor'], undefined, adapter);
    await removeTenantRole(userId, 't1', 'admin', undefined, adapter);
    const roles = await getTenantRoles(userId, 't1', adapter);
    expect(roles).not.toContain('admin');
    expect(roles).toContain('editor');
  });
});
