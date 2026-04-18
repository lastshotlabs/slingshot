// Requires a running Postgres instance.
// Run with: bun test tests/docker/postgres-adapter.test.ts
// Default connection: postgresql://postgres:postgres@localhost:5433/slingshot_test
// Override: TEST_POSTGRES_URL=<url> bun test tests/docker/postgres-adapter.test.ts
//
// createPostgresAdapter() runs schema migrations automatically on first connection.
// No manual schema setup is required.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { HttpError } from '@lastshotlabs/slingshot-core';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { createPostgresAdapter } from '@lastshotlabs/slingshot-postgres';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('PostgresAdapter (docker)', () => {
  let pool: Pool;
  let adapter: AuthAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    // Migrations run automatically inside createPostgresAdapter.
    adapter = await createPostgresAdapter({ pool });
  });

  beforeEach(async () => {
    // Delete in FK-safe order. CASCADE on users handles webauthn_credentials and
    // recovery_codes; CASCADE on groups handles group_memberships.
    await pool.query(`
      DELETE FROM slingshot_group_memberships;
      DELETE FROM slingshot_groups;
      DELETE FROM slingshot_tenant_roles;
      DELETE FROM slingshot_user_roles;
      DELETE FROM slingshot_oauth_accounts;
      DELETE FROM slingshot_users;
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('create and findByEmail', async () => {
    const hash = await Bun.password.hash('secret123');
    const { id } = await adapter.create('alice@example.com', hash);
    expect(id).toBeString();

    const found = await adapter.findByEmail('alice@example.com');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.passwordHash).toBe(hash);
  });

  test('findByEmail returns null for unknown email', async () => {
    const result = await adapter.findByEmail('nobody@example.com');
    expect(result).toBeNull();
  });

  test('verifyPassword', async () => {
    const hash = await Bun.password.hash('hunter2');
    const { id } = await adapter.create('bob@example.com', hash);

    expect(await adapter.verifyPassword(id, 'hunter2')).toBe(true);
    expect(await adapter.verifyPassword(id, 'wrong')).toBe(false);
  });

  test('getIdentifier returns email', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('carol@example.com', hash);
    const identifier = await adapter.getIdentifier(id);
    expect(identifier).toBe('carol@example.com');
  });

  test('consumeRecoveryCode returns false when no codes are set', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('mfa@example.com', hash);
    // No recovery codes set — atomic DELETE returns empty, so false.
    const result = await adapter.consumeRecoveryCode(id, 'hashed-code');
    expect(result).toBe(false);
  });

  test('setEmailVerified and getEmailVerified', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('dave@example.com', hash);

    expect(await adapter.getEmailVerified!(id)).toBe(false);
    await adapter.setEmailVerified!(id, true);
    expect(await adapter.getEmailVerified!(id)).toBe(true);
  });

  test('getUser returns full profile', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('eve@example.com', hash);
    const user = await adapter.getUser!(id);
    expect(user).not.toBeNull();
    expect(user!.email).toBe('eve@example.com');
    expect(user!.suspended).toBe(false);
    expect(user!.emailVerified).toBe(false);
  });

  test('setPassword updates hash', async () => {
    const hash = await Bun.password.hash('old');
    const { id } = await adapter.create('frank@example.com', hash);
    const newHash = await Bun.password.hash('new');
    await adapter.setPassword!(id, newHash);
    expect(await adapter.verifyPassword(id, 'new')).toBe(true);
    expect(await adapter.verifyPassword(id, 'old')).toBe(false);
  });

  test('oauth: findOrCreateByProvider creates new user', async () => {
    const result = await adapter.findOrCreateByProvider!('google', 'google-uid-1', {
      email: 'gina@example.com',
      displayName: 'Gina',
    });
    expect(result.created).toBe(true);
    expect(result.id).toBeString();

    // Calling again returns same user
    const result2 = await adapter.findOrCreateByProvider!('google', 'google-uid-1', {
      email: 'gina@example.com',
    });
    expect(result2.created).toBe(false);
    expect(result2.id).toBe(result.id);
  });

  test('oauth: findOrCreateByProvider throws HttpError(409) for email conflict', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('existing@example.com', hash);

    const thrown = await adapter.findOrCreateByProvider!('google', 'google-new-uid', {
      email: 'existing@example.com',
    }).catch(e => e);

    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('PROVIDER_EMAIL_CONFLICT');
  });

  test('oauth: linkProvider and unlinkProvider', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('hank@example.com', hash);

    await adapter.linkProvider!(id, 'github', 'gh-uid-1');
    // linking twice should not error
    await adapter.linkProvider!(id, 'github', 'gh-uid-1');

    await adapter.unlinkProvider!(id, 'github');
    // verify unlinked — re-creating with same provider should create new user
    const result = await adapter.findOrCreateByProvider!('github', 'gh-uid-1', {
      email: 'other@example.com',
    });
    expect(result.id).not.toBe(id);
  });

  test('user roles: getRoles, setRoles, addRole, removeRole', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('irene@example.com', hash);

    expect(await adapter.getRoles!(id)).toEqual([]);

    await adapter.setRoles!(id, ['admin', 'user']);
    const roles = await adapter.getRoles!(id);
    expect(roles.sort()).toEqual(['admin', 'user']);

    await adapter.removeRole!(id, 'admin');
    expect(await adapter.getRoles!(id)).toEqual(['user']);

    await adapter.addRole!(id, 'editor');
    expect((await adapter.getRoles!(id)).sort()).toEqual(['editor', 'user']);

    // addRole idempotent
    await adapter.addRole!(id, 'editor');
    expect((await adapter.getRoles!(id)).sort()).toEqual(['editor', 'user']);
  });

  test('tenant roles: getTenantRoles, setTenantRoles, addTenantRole, removeTenantRole', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('jack@example.com', hash);
    const tenantId = 'tenant-abc';

    expect(await adapter.getTenantRoles!(id, tenantId)).toEqual([]);

    await adapter.setTenantRoles!(id, tenantId, ['member', 'editor']);
    const roles = await adapter.getTenantRoles!(id, tenantId);
    expect(roles.sort()).toEqual(['editor', 'member']);

    await adapter.removeTenantRole!(id, tenantId, 'member');
    expect(await adapter.getTenantRoles!(id, tenantId)).toEqual(['editor']);

    await adapter.addTenantRole!(id, tenantId, 'owner');
    expect((await adapter.getTenantRoles!(id, tenantId)).sort()).toEqual(['editor', 'owner']);

    // Tenant roles are isolated per tenant
    expect(await adapter.getTenantRoles!(id, 'other-tenant')).toEqual([]);
  });

  test('suspension: setSuspended and getSuspended', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('kate@example.com', hash);

    expect(await adapter.getSuspended!(id)).toEqual({
      suspended: false,
      suspendedReason: undefined,
    });

    await adapter.setSuspended!(id, true, 'violated ToS');
    const state = await adapter.getSuspended!(id);
    expect(state?.suspended).toBe(true);
    expect(state?.suspendedReason).toBe('violated ToS');

    // Unsuspend clears reason
    await adapter.setSuspended!(id, false);
    const cleared = await adapter.getSuspended!(id);
    expect(cleared?.suspended).toBe(false);
    expect(cleared?.suspendedReason).toBeUndefined();
  });

  test('suspension: setSuspended sets and clears suspendedAt via listUsers', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('leo-suspend@example.com', hash);
    const found = await adapter.findByEmail('leo-suspend@example.com');
    const id = found!.id;

    await adapter.setSuspended!(id, true, 'test');
    const { users: suspended } = await adapter.listUsers!({ suspended: true });
    const match = suspended.find(u => u.id === id);
    expect(match).toBeDefined();
    expect(match!.suspendedAt).toBeInstanceOf(Date);

    await adapter.setSuspended!(id, false);
    const { users: active } = await adapter.listUsers!({ suspended: false });
    const cleared = active.find(u => u.id === id);
    expect(cleared).toBeDefined();
    expect(cleared!.suspendedAt).toBeUndefined();
  });

  test('listUsers: no filters returns all users', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('list1@example.com', hash);
    await adapter.create('list2@example.com', hash);
    const { users, totalResults } = await adapter.listUsers!({});
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(totalResults).toBeGreaterThanOrEqual(2);
  });

  test('listUsers: email filter is case-insensitive partial match', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('filter-target@example.com', hash);
    await adapter.create('other@domain.com', hash);
    const { users } = await adapter.listUsers!({ email: 'filter-target' });
    expect(users.every(u => u.email?.includes('filter-target'))).toBe(true);
  });

  test('listUsers: suspended filter returns only matching users', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: suspId } = await adapter.create('susp@example.com', hash);
    await adapter.create('active@example.com', hash);
    await adapter.setSuspended!(suspId, true);

    const { users: suspendedUsers } = await adapter.listUsers!({ suspended: true });
    expect(suspendedUsers.every(u => u.suspended)).toBe(true);

    const { users: activeUsers } = await adapter.listUsers!({ suspended: false });
    expect(activeUsers.every(u => !u.suspended)).toBe(true);
  });

  test('listUsers: externalId filter returns only matching users', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('ext1@example.com', hash);
    await adapter.create('ext2@example.com', hash);
    const found1 = await adapter.findByEmail('ext1@example.com');
    await adapter.updateProfile!(found1!.id, { externalId: 'scim-uid-999' });

    const { users } = await adapter.listUsers!({ externalId: 'scim-uid-999' });
    expect(users).toHaveLength(1);
    expect(users[0].externalId).toBe('scim-uid-999');
  });

  test('deleteUser removes user and cascades', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('leo@example.com', hash);
    await adapter.setRoles!(id, ['user']);
    await adapter.linkProvider!(id, 'google', 'google-uid-leo');

    await adapter.deleteUser!(id);

    expect(await adapter.findByEmail('leo@example.com')).toBeNull();
    expect(await adapter.getUser!(id)).toBeNull();
  });

  test('getSuspended returns null for unknown user', async () => {
    const result = await adapter.getSuspended!('nonexistent-id');
    expect(result).toBeNull();
  });

  // ── Tier 3 — MFA ────────────────────────────────────────────────────────────

  test('MFA: set/get secret, enable/disable, methods', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('mfa-full@example.com', hash);

    expect(await adapter.getMfaSecret!(id)).toBeNull();
    await adapter.setMfaSecret!(id, 'base32secret');
    expect(await adapter.getMfaSecret!(id)).toBe('base32secret');

    expect(await adapter.isMfaEnabled!(id)).toBe(false);
    await adapter.setMfaEnabled!(id, true);
    expect(await adapter.isMfaEnabled!(id)).toBe(true);
    await adapter.setMfaEnabled!(id, false);
    expect(await adapter.isMfaEnabled!(id)).toBe(false);

    expect(await adapter.getMfaMethods!(id)).toEqual([]);
    await adapter.setMfaMethods!(id, ['totp', 'email']);
    expect((await adapter.getMfaMethods!(id)).sort()).toEqual(['email', 'totp']);
    await adapter.setMfaMethods!(id, []);
    expect(await adapter.getMfaMethods!(id)).toEqual([]);
  });

  test('MFA: recovery codes — set, get, consume, replace', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('recovery-full@example.com', hash);

    await adapter.setRecoveryCodes!(id, ['hash1', 'hash2', 'hash3']);
    expect((await adapter.getRecoveryCodes!(id)).sort()).toEqual(['hash1', 'hash2', 'hash3']);

    // Consuming an existing code returns true and removes it
    expect(await adapter.consumeRecoveryCode(id, 'hash1')).toBe(true);
    // Consuming the same code again returns false
    expect(await adapter.consumeRecoveryCode(id, 'hash1')).toBe(false);

    expect((await adapter.getRecoveryCodes!(id)).sort()).toEqual(['hash2', 'hash3']);

    // removeRecoveryCode removes a single code
    await adapter.removeRecoveryCode!(id, 'hash2');
    expect(await adapter.getRecoveryCodes!(id)).toEqual(['hash3']);

    // setRecoveryCodes replaces all existing codes atomically
    await adapter.setRecoveryCodes!(id, ['newA', 'newB']);
    expect((await adapter.getRecoveryCodes!(id)).sort()).toEqual(['newA', 'newB']);
  });

  // ── Tier 4 — WebAuthn ───────────────────────────────────────────────────────

  test('WebAuthn: add, get, findUser, updateSignCount, remove', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('webauthn-full@example.com', hash);

    expect(await adapter.getWebAuthnCredentials!(id)).toHaveLength(0);

    const createdAt = Date.now();
    await adapter.addWebAuthnCredential!(id, {
      credentialId: 'cred-abc',
      publicKey: 'pub-key-base64',
      signCount: 0,
      transports: ['usb', 'nfc'],
      name: 'My Security Key',
      createdAt,
    });

    const creds = await adapter.getWebAuthnCredentials!(id);
    expect(creds).toHaveLength(1);
    expect(creds[0].credentialId).toBe('cred-abc');
    expect(creds[0].publicKey).toBe('pub-key-base64');
    expect(creds[0].signCount).toBe(0);
    expect(creds[0].transports).toEqual(['usb', 'nfc']);
    expect(creds[0].name).toBe('My Security Key');

    expect(await adapter.findUserByWebAuthnCredentialId!('cred-abc')).toBe(id);
    expect(await adapter.findUserByWebAuthnCredentialId!('nonexistent')).toBeNull();

    await adapter.updateWebAuthnCredentialSignCount!(id, 'cred-abc', 42);
    expect((await adapter.getWebAuthnCredentials!(id))[0].signCount).toBe(42);

    // Add a second credential (no name, no transports)
    await adapter.addWebAuthnCredential!(id, {
      credentialId: 'cred-xyz',
      publicKey: 'pub-key-2',
      signCount: 1,
      createdAt: Date.now(),
    });
    expect(await adapter.getWebAuthnCredentials!(id)).toHaveLength(2);

    await adapter.removeWebAuthnCredential!(id, 'cred-abc');
    const remaining = await adapter.getWebAuthnCredentials!(id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].credentialId).toBe('cred-xyz');
  });

  // ── Tier 6 — Groups ─────────────────────────────────────────────────────────

  test('groups: create, get, update, delete', async () => {
    const { id: gId } = await adapter.createGroup!({
      name: 'Admins',
      roles: ['admin'],
      tenantId: null,
    });
    expect(gId).toBeString();

    const group = await adapter.getGroup!(gId);
    expect(group).not.toBeNull();
    expect(group!.name).toBe('Admins');
    expect(group!.roles).toEqual(['admin']);
    expect(group!.tenantId).toBeNull();
    expect(group!.createdAt).toBeNumber();

    await adapter.updateGroup!(gId, { displayName: 'Administrators', roles: ['admin', 'read'] });
    const updated = await adapter.getGroup!(gId);
    expect(updated!.displayName).toBe('Administrators');
    expect(updated!.roles.sort()).toEqual(['admin', 'read']);

    await adapter.deleteGroup!(gId);
    expect(await adapter.getGroup!(gId)).toBeNull();
  });

  test('groups: name uniqueness per scope', async () => {
    await adapter.createGroup!({ name: 'SharedName', tenantId: 'tenant-scope-1', roles: [] });
    // Same name in a different tenant — allowed
    await adapter.createGroup!({ name: 'SharedName', tenantId: 'tenant-scope-2', roles: [] });

    // Duplicate in the same tenant — 409
    const thrown = await adapter.createGroup!({
      name: 'SharedName',
      tenantId: 'tenant-scope-1',
      roles: [],
    }).catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('GROUP_NAME_CONFLICT');
  });

  test('groups: listGroups with cursor pagination', async () => {
    const tid = 'tenant-pag';
    await adapter.createGroup!({ name: 'G-A', tenantId: tid, roles: [] });
    await adapter.createGroup!({ name: 'G-B', tenantId: tid, roles: [] });
    await adapter.createGroup!({ name: 'G-C', tenantId: tid, roles: [] });

    const page1 = await adapter.listGroups!(tid, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeString();

    const page2 = await adapter.listGroups!(tid, { cursor: page1.nextCursor, limit: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const allNames = [...page1.items, ...page2.items].map(g => g.name).sort();
    expect(allNames).toEqual(['G-A', 'G-B', 'G-C']);
  });

  test('groups: tenant scope isolation in listGroups', async () => {
    await adapter.createGroup!({ name: 'Isolated', tenantId: 'tenant-iso-1', roles: [] });
    await adapter.createGroup!({ name: 'Global', roles: [], tenantId: null }); // tenantId = null

    const { items: tenantGroups } = await adapter.listGroups!('tenant-iso-1');
    expect(tenantGroups.every(g => g.tenantId === 'tenant-iso-1')).toBe(true);

    const { items: globalGroups } = await adapter.listGroups!(null);
    expect(globalGroups.every(g => g.tenantId === null)).toBe(true);
  });

  test('groups: membership — add, getMembers, updateMembership, remove', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: u1 } = await adapter.create('member1@example.com', hash);
    const { id: u2 } = await adapter.create('member2@example.com', hash);
    const { id: gId } = await adapter.createGroup!({
      name: 'Eng',
      tenantId: 'tenant-eng',
      roles: [],
    });

    await adapter.addGroupMember!(gId, u1, ['write']);
    await adapter.addGroupMember!(gId, u2);

    const members = await adapter.getGroupMembers!(gId);
    expect(members.items).toHaveLength(2);
    const u1member = members.items.find(m => m.userId === u1);
    expect(u1member?.roles).toEqual(['write']);

    await adapter.updateGroupMembership!(gId, u1, ['write', 'read']);
    const updated = await adapter.getGroupMembers!(gId);
    const updatedMember = updated.items.find(m => m.userId === u1);
    expect(updatedMember?.roles.sort()).toEqual(['read', 'write']);

    await adapter.removeGroupMember!(gId, u1);
    expect((await adapter.getGroupMembers!(gId)).items).toHaveLength(1);
  });

  test('groups: addGroupMember throws 409 on duplicate', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: userId } = await adapter.create('dup-member@example.com', hash);
    const { id: gId } = await adapter.createGroup!({
      name: 'DupGroup',
      tenantId: 'tenant-dup',
      roles: [],
    });

    await adapter.addGroupMember!(gId, userId);
    const thrown = await adapter.addGroupMember!(gId, userId).catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('GROUP_MEMBER_CONFLICT');
  });

  test('groups: getGroupMembers cursor pagination', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: g } = await adapter.createGroup!({
      name: 'BigGroup',
      tenantId: 'tenant-big',
      roles: [],
    });
    const userIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await adapter.create(`big-member-${i}@example.com`, hash);
      await adapter.addGroupMember!(g, id);
      userIds.push(id);
    }

    const page1 = await adapter.getGroupMembers!(g, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeString();

    const page2 = await adapter.getGroupMembers!(g, { cursor: page1.nextCursor, limit: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const allIds = [...page1.items, ...page2.items].map(m => m.userId).sort();
    expect(allIds).toEqual(userIds.sort());
  });

  test('groups: getUserGroups scoped by tenantId', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: userId } = await adapter.create('group-user@example.com', hash);
    const { id: g1 } = await adapter.createGroup!({
      name: 'Team',
      tenantId: 'tenant-gu',
      roles: [],
    });
    const { id: g2 } = await adapter.createGroup!({ name: 'Org', roles: [], tenantId: null }); // global

    await adapter.addGroupMember!(g1, userId, ['member']);
    await adapter.addGroupMember!(g2, userId, ['viewer']);

    const tenantGroups = await adapter.getUserGroups!(userId, 'tenant-gu');
    expect(tenantGroups).toHaveLength(1);
    expect(tenantGroups[0].group.name).toBe('Team');
    expect(tenantGroups[0].membershipRoles).toEqual(['member']);

    const globalGroups = await adapter.getUserGroups!(userId, null);
    expect(globalGroups).toHaveLength(1);
    expect(globalGroups[0].group.name).toBe('Org');
  });

  test('groups: getEffectiveRoles combines direct + group + membership roles', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: userId } = await adapter.create('eff-roles@example.com', hash);
    const { id: gId } = await adapter.createGroup!({
      name: 'Dev',
      roles: ['read'],
      tenantId: 'tenant-eff',
    });

    // Direct tenant role
    await adapter.addTenantRole!(userId, 'tenant-eff', 'owner');
    // Group membership role
    await adapter.addGroupMember!(gId, userId, ['write']);

    const effective = await adapter.getEffectiveRoles!(userId, 'tenant-eff');
    // 'owner' from direct; 'read' from group.roles; 'write' from membership.roles
    expect(effective.sort()).toEqual(['owner', 'read', 'write']);

    // After removing from group, only direct role remains
    await adapter.removeGroupMember!(gId, userId);
    const afterRemoval = await adapter.getEffectiveRoles!(userId, 'tenant-eff');
    expect(afterRemoval).toEqual(['owner']);
  });

  test('groups: getEffectiveRoles — global (null tenantId) uses userRoles', async () => {
    const hash = await Bun.password.hash('pw');
    const { id: userId } = await adapter.create('eff-global@example.com', hash);
    const { id: gId } = await adapter.createGroup!({
      name: 'GlobalDev',
      roles: ['read'],
      tenantId: null,
    });

    await adapter.addRole!(userId, 'superuser');
    await adapter.addGroupMember!(gId, userId, ['deploy']);

    const effective = await adapter.getEffectiveRoles!(userId, null);
    expect(effective.sort()).toEqual(['deploy', 'read', 'superuser']);
  });
});
