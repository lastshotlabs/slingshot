/**
 * Shared adapter parity test suite.
 *
 * Verifies that all AuthAdapter implementations produce identical output for
 * identical input across every tier of the adapter interface. Each backend
 * (memory, sqlite, mongo) calls `adapterParitySuite` with its own factory and
 * reset functions so the same assertions run against every backend.
 *
 * M2M / Enterprise tier is excluded — those methods require pre-hashed secrets
 * whose generation differs across backends.
 */
import { describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

/**
 * Workaround for a Bun v1.3.x bug where `expect(p).rejects.*` hangs ~5000ms
 * on the first call in a test file when `p` is a Promise from a MongoDB driver
 * or similar I/O-backed operation. Subsequent calls work instantly. Using
 * try/catch directly avoids this issue and is safe for all adapter backends.
 */
async function assertRejects(promise: Promise<unknown>, message?: string): Promise<void> {
  let threw = false;
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    threw = true;
    error = e;
  }
  expect(threw).toBe(true);
  if (message !== undefined) {
    expect((error as Error).message).toContain(message);
  }
}

export interface ParitySuiteOpts {
  /** Human-readable backend name for describe blocks. */
  name: string;
  /** Return a fresh or reset adapter. Called in beforeEach by the caller. */
  getAdapter: () => AuthAdapter;
}

export function adapterParitySuite({ name, getAdapter }: ParitySuiteOpts) {
  // Convenience: always access via function so beforeEach swap is respected
  const a = () => getAdapter();

  describe(`adapter parity — ${name}`, () => {
    // -------------------------------------------------------------------
    // Tier 1 — Core
    // -------------------------------------------------------------------

    describe('Tier 1: Core', () => {
      test('create + findByEmail round-trip', async () => {
        const { id } = await a().create('alice@example.com', await Bun.password.hash('secret'));
        expect(id).toBeTruthy();

        const found = await a().findByEmail('alice@example.com');
        expect(found).not.toBeNull();
        expect(found!.id).toBe(id);
        expect(typeof found!.passwordHash).toBe('string');
      });

      test('findByEmail returns null for non-existent user', async () => {
        expect(await a().findByEmail('nobody@example.com')).toBeNull();
      });

      test('duplicate email throws', async () => {
        await a().create('dup@example.com', 'hash1');
        await assertRejects(a().create('dup@example.com', 'hash2'));
      });

      test('verifyPassword succeeds with correct password', async () => {
        const hash = await Bun.password.hash('correct-horse');
        const { id } = await a().create('verify@example.com', hash);
        expect(await a().verifyPassword(id, 'correct-horse')).toBe(true);
      });

      test('verifyPassword fails with wrong password', async () => {
        const hash = await Bun.password.hash('correct-horse');
        const { id } = await a().create('verify2@example.com', hash);
        expect(await a().verifyPassword(id, 'wrong-horse')).toBe(false);
      });

      test('getIdentifier returns email', async () => {
        const { id } = await a().create('ident@example.com', 'hash');
        const ident = await a().getIdentifier(id);
        expect(ident).toBe('ident@example.com');
      });

      test('getUser returns profile fields', async () => {
        const { id } = await a().create('profile@example.com', 'hash');
        const user = await a().getUser!(id);
        expect(user).not.toBeNull();
        expect(user!.email).toBe('profile@example.com');
        expect(user!.emailVerified).toBe(false);
        expect(user!.suspended).toBe(false);
      });

      test('getUser returns null for non-existent id', async () => {
        // Use a plausible-looking ID that won't exist
        const user = await a().getUser!('000000000000000000000000');
        expect(user).toBeNull();
      });

      test('deleteUser removes the user', async () => {
        const { id } = await a().create('doomed@example.com', 'hash');
        await a().deleteUser!(id);
        expect(await a().findByEmail('doomed@example.com')).toBeNull();
      });

      test('setPassword + hasPassword', async () => {
        const { id } = await a().create('pw@example.com', '');
        expect(await a().hasPassword!(id)).toBe(false);

        await a().setPassword!(id, await Bun.password.hash('new-pw'));
        expect(await a().hasPassword!(id)).toBe(true);
      });

      test('updateProfile sets displayName', async () => {
        const { id } = await a().create('upd@example.com', 'hash');
        await a().updateProfile!(id, { displayName: 'Alice' });
        const user = await a().getUser!(id);
        expect(user!.displayName).toBe('Alice');
      });

      test('emailVerified defaults false, toggles to true', async () => {
        const { id } = await a().create('ev@example.com', 'hash');
        expect(await a().getEmailVerified!(id)).toBe(false);

        await a().setEmailVerified!(id, true);
        expect(await a().getEmailVerified!(id)).toBe(true);
      });

      test('consumeRecoveryCode removes matching code', async () => {
        const { id } = await a().create('rc@example.com', 'hash');
        await a().setRecoveryCodes!(id, ['aaa', 'bbb', 'ccc']);
        const consumed = await a().consumeRecoveryCode(id, 'bbb');
        expect(consumed).toBe(true);
        expect(await a().getRecoveryCodes!(id)).toEqual(['aaa', 'ccc']);
      });

      test('consumeRecoveryCode returns false for non-matching code', async () => {
        const { id } = await a().create('rc2@example.com', 'hash');
        await a().setRecoveryCodes!(id, ['aaa']);
        expect(await a().consumeRecoveryCode(id, 'zzz')).toBe(false);
      });
    });

    // -------------------------------------------------------------------
    // Tier 2 — OAuth
    // -------------------------------------------------------------------

    describe('Tier 2: OAuth', () => {
      test('findOrCreateByProvider creates on first call', async () => {
        const result = await a().findOrCreateByProvider!('google', 'gid-1', {
          email: 'oauth@example.com',
        });
        expect(result.created).toBe(true);
        expect(result.id).toBeTruthy();
      });

      test('findOrCreateByProvider finds on second call', async () => {
        const first = await a().findOrCreateByProvider!('google', 'gid-2', {
          email: 'o2@example.com',
        });
        const second = await a().findOrCreateByProvider!('google', 'gid-2', {
          email: 'o2@example.com',
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
      });

      test('findOrCreateByProvider rejects email collision with credential account', async () => {
        await a().create('taken@example.com', 'hash');
        await assertRejects(
          a().findOrCreateByProvider!('google', 'gid-3', { email: 'taken@example.com' }),
        );
      });

      test('linkProvider + unlinkProvider', async () => {
        const { id } = await a().create('link@example.com', 'hash');
        await a().linkProvider!(id, 'google', 'gid-link');

        const user = await a().getUser!(id);
        expect(user!.providerIds).toContain('google:gid-link');

        await a().unlinkProvider!(id, 'google');
        const updated = await a().getUser!(id);
        expect(updated!.providerIds).not.toContain('google:gid-link');
      });

      test('linkProvider is idempotent', async () => {
        const { id } = await a().create('idemp@example.com', 'hash');
        await a().linkProvider!(id, 'google', 'gid-same');
        await a().linkProvider!(id, 'google', 'gid-same');

        const user = await a().getUser!(id);
        const count = user!.providerIds!.filter(p => p === 'google:gid-same').length;
        expect(count).toBe(1);
      });

      test('linkProvider rejects linking a provider account that already belongs to another user', async () => {
        const first = await a().create('oauth-owner@example.com', 'hash');
        const second = await a().create('oauth-other@example.com', 'hash');

        await a().linkProvider!(first.id, 'google', 'gid-conflict');
        await assertRejects(a().linkProvider!(second.id, 'google', 'gid-conflict'));

        const firstUser = await a().getUser!(first.id);
        const secondUser = await a().getUser!(second.id);
        expect(firstUser!.providerIds).toContain('google:gid-conflict');
        expect(secondUser!.providerIds ?? []).not.toContain('google:gid-conflict');
      });
    });

    // -------------------------------------------------------------------
    // Tier 3 — MFA
    // -------------------------------------------------------------------

    describe('Tier 3: MFA', () => {
      test('MFA secret defaults null, can be set', async () => {
        const { id } = await a().create('mfa@example.com', 'hash');
        expect(await a().getMfaSecret!(id)).toBeNull();

        await a().setMfaSecret!(id, 'JBSWY3DPEHPK3PXP');
        expect(await a().getMfaSecret!(id)).toBe('JBSWY3DPEHPK3PXP');
      });

      test('MFA enabled defaults false, can be toggled', async () => {
        const { id } = await a().create('mfa2@example.com', 'hash');
        expect(await a().isMfaEnabled!(id)).toBe(false);

        await a().setMfaEnabled!(id, true);
        expect(await a().isMfaEnabled!(id)).toBe(true);
      });

      test('recovery codes round-trip', async () => {
        const { id } = await a().create('codes@example.com', 'hash');
        const codes = ['code1', 'code2', 'code3'];

        await a().setRecoveryCodes!(id, codes);
        expect(await a().getRecoveryCodes!(id)).toEqual(codes);

        await a().removeRecoveryCode!(id, 'code2');
        expect(await a().getRecoveryCodes!(id)).toEqual(['code1', 'code3']);
      });

      test('MFA methods round-trip', async () => {
        const { id } = await a().create('methods@example.com', 'hash');
        expect(await a().getMfaMethods!(id)).toEqual([]);

        await a().setMfaMethods!(id, ['totp', 'email-otp']);
        expect(await a().getMfaMethods!(id)).toEqual(['totp', 'email-otp']);
      });
    });

    // -------------------------------------------------------------------
    // Tier 4 — WebAuthn
    // -------------------------------------------------------------------

    describe('Tier 4: WebAuthn', () => {
      const cred = {
        credentialId: 'cred-abc',
        publicKey: 'pk-abc',
        signCount: 0,
        transports: ['usb'] as string[],
        name: 'My Key',
        createdAt: 1700000000000,
      };

      test('add + retrieve credential', async () => {
        const { id } = await a().create('wa@example.com', 'hash');
        await a().addWebAuthnCredential!(id, cred);

        const creds = await a().getWebAuthnCredentials!(id);
        expect(creds).toHaveLength(1);
        expect(creds[0].credentialId).toBe('cred-abc');
        expect(creds[0].publicKey).toBe('pk-abc');
        expect(creds[0].signCount).toBe(0);
        expect(creds[0].transports).toEqual(['usb']);
        expect(creds[0].name).toBe('My Key');
      });

      test('updateWebAuthnCredentialSignCount', async () => {
        const { id } = await a().create('wa2@example.com', 'hash');
        await a().addWebAuthnCredential!(id, cred);
        await a().updateWebAuthnCredentialSignCount!(id, 'cred-abc', 5);

        const creds = await a().getWebAuthnCredentials!(id);
        expect(creds[0].signCount).toBe(5);
      });

      test('removeWebAuthnCredential', async () => {
        const { id } = await a().create('wa3@example.com', 'hash');
        await a().addWebAuthnCredential!(id, cred);
        await a().removeWebAuthnCredential!(id, 'cred-abc');

        expect(await a().getWebAuthnCredentials!(id)).toHaveLength(0);
      });

      test('findUserByWebAuthnCredentialId', async () => {
        const { id } = await a().create('wa4@example.com', 'hash');
        await a().addWebAuthnCredential!(id, { ...cred, credentialId: 'cred-find' });

        expect(await a().findUserByWebAuthnCredentialId!('cred-find')).toBe(id);
        expect(await a().findUserByWebAuthnCredentialId!('nope')).toBeNull();
      });
    });

    // -------------------------------------------------------------------
    // Tier 5 — Roles
    // -------------------------------------------------------------------

    describe('Tier 5: Roles', () => {
      test('roles default empty, set/add/remove', async () => {
        const { id } = await a().create('roles@example.com', 'hash');
        expect(await a().getRoles!(id)).toEqual([]);

        await a().setRoles!(id, ['admin', 'user']);
        expect(await a().getRoles!(id)).toEqual(['admin', 'user']);

        await a().addRole!(id, 'editor');
        expect(await a().getRoles!(id)).toContain('editor');

        await a().removeRole!(id, 'admin');
        expect(await a().getRoles!(id)).not.toContain('admin');
      });

      test('addRole is idempotent', async () => {
        const { id } = await a().create('roledup@example.com', 'hash');
        await a().addRole!(id, 'admin');
        await a().addRole!(id, 'admin');
        const roles = await a().getRoles!(id);
        expect(roles.filter(r => r === 'admin').length).toBe(1);
      });

      test('tenant-scoped roles', async () => {
        const { id } = await a().create('tr@example.com', 'hash');
        const tid = 'tenant-1';

        expect(await a().getTenantRoles!(id, tid)).toEqual([]);

        await a().setTenantRoles!(id, tid, ['admin']);
        expect(await a().getTenantRoles!(id, tid)).toEqual(['admin']);

        await a().addTenantRole!(id, tid, 'editor');
        expect(await a().getTenantRoles!(id, tid)).toContain('editor');

        await a().removeTenantRole!(id, tid, 'admin');
        const roles = await a().getTenantRoles!(id, tid);
        expect(roles).not.toContain('admin');
        expect(roles).toContain('editor');
      });
    });

    // -------------------------------------------------------------------
    // Tier 6 — Groups
    // -------------------------------------------------------------------

    describe('Tier 6: Groups', () => {
      test('createGroup + getGroup round-trip', async () => {
        const { id } = await a().createGroup!({
          name: 'engineers',
          roles: ['dev'],
          tenantId: null,
        });
        expect(id).toBeTruthy();

        const group = await a().getGroup!(id);
        expect(group).not.toBeNull();
        expect(group!.name).toBe('engineers');
        expect(group!.roles).toEqual(['dev']);
        expect(group!.tenantId).toBeNull();
      });

      test('listGroups returns created groups', async () => {
        await a().createGroup!({ name: 'alpha', roles: [], tenantId: null });
        await a().createGroup!({ name: 'beta', roles: [], tenantId: null });

        const result = await a().listGroups!(null);
        expect(result.items).toHaveLength(2);
      });

      test('updateGroup modifies fields', async () => {
        const { id } = await a().createGroup!({ name: 'old-name', roles: [], tenantId: null });
        await a().updateGroup!(id, { name: 'new-name', roles: ['admin'] });

        const group = await a().getGroup!(id);
        expect(group!.name).toBe('new-name');
        expect(group!.roles).toEqual(['admin']);
      });

      test('deleteGroup removes group', async () => {
        const { id } = await a().createGroup!({ name: 'doomed', roles: [], tenantId: null });
        await a().deleteGroup!(id);
        expect(await a().getGroup!(id)).toBeNull();
      });

      test('group membership CRUD', async () => {
        const { id: groupId } = await a().createGroup!({
          name: 'team',
          roles: ['member'],
          tenantId: null,
        });
        const { id: userId } = await a().create('gm@example.com', 'hash');

        await a().addGroupMember!(groupId, userId, ['lead']);
        const members = await a().getGroupMembers!(groupId);
        expect(members.items).toHaveLength(1);
        expect(members.items[0].userId).toBe(userId);
        expect(members.items[0].roles).toEqual(['lead']);

        await a().updateGroupMembership!(groupId, userId, ['lead', 'reviewer']);
        const updated = await a().getGroupMembers!(groupId);
        expect(updated.items[0].roles).toEqual(['lead', 'reviewer']);

        await a().removeGroupMember!(groupId, userId);
        const after = await a().getGroupMembers!(groupId);
        expect(after.items).toHaveLength(0);
      });

      test('getUserGroups returns memberships', async () => {
        const { id: gid } = await a().createGroup!({
          name: 'ug-grp',
          roles: ['base'],
          tenantId: null,
        });
        const { id: uid } = await a().create('ug@example.com', 'hash');
        await a().addGroupMember!(gid, uid, ['extra']);

        const groups = await a().getUserGroups!(uid, null);
        expect(groups).toHaveLength(1);
        expect(groups[0].group.name).toBe('ug-grp');
        expect(groups[0].membershipRoles).toEqual(['extra']);
      });

      test('getEffectiveRoles merges group + membership roles', async () => {
        const { id: gid } = await a().createGroup!({
          name: 'eff-grp',
          roles: ['base'],
          tenantId: null,
        });
        const { id: uid } = await a().create('eff@example.com', 'hash');
        await a().addGroupMember!(gid, uid, ['extra']);

        const roles = await a().getEffectiveRoles!(uid, null);
        expect(roles).toContain('base');
        expect(roles).toContain('extra');
      });
    });

    // -------------------------------------------------------------------
    // Tier 7 — Suspension
    // -------------------------------------------------------------------

    describe('Tier 7: Suspension', () => {
      test('setSuspended + getSuspended round-trip', async () => {
        const { id } = await a().create('sus@example.com', 'hash');
        await a().setSuspended!(id, true, 'Violation');

        const status = await a().getSuspended!(id);
        expect(status!.suspended).toBe(true);
        expect(status!.suspendedReason).toBe('Violation');
      });

      test('unsuspend clears reason', async () => {
        const { id } = await a().create('unsus@example.com', 'hash');
        await a().setSuspended!(id, true, 'Reason');
        await a().setSuspended!(id, false);

        const status = await a().getSuspended!(id);
        expect(status!.suspended).toBe(false);
        expect(status!.suspendedReason).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------
    // Tier 8 — Enterprise (listUsers only — M2M needs pre-hashed secrets)
    // -------------------------------------------------------------------

    describe('Tier 8: Enterprise (listUsers)', () => {
      test('listUsers returns all users', async () => {
        await a().create('a@example.com', 'h1');
        await a().create('b@example.com', 'h2');

        const result = await a().listUsers!({});
        expect(result.totalResults).toBe(2);
        expect(result.users.length).toBe(2);
      });

      test('listUsers filters by email', async () => {
        await a().create('find@example.com', 'h1');
        await a().create('other@example.com', 'h2');

        const result = await a().listUsers!({ email: 'find@example.com' });
        expect(result.totalResults).toBe(1);
        expect(result.users[0].email).toBe('find@example.com');
      });

      test('listUsers pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await a().create(`p${i}@example.com`, 'hash');
        }
        const page = await a().listUsers!({ startIndex: 0, count: 2 });
        expect(page.users.length).toBe(2);
        expect(page.totalResults).toBe(5);
      });
    });

    // -------------------------------------------------------------------
    // Cross-cutting: metadata
    // -------------------------------------------------------------------

    describe('Cross-cutting: metadata', () => {
      test('userMetadata round-trip', async () => {
        const { id } = await a().create('meta@example.com', 'hash');
        await a().setUserMetadata!(id, { plan: 'pro', seats: 5 });

        const result = await a().getUserMetadata!(id);
        expect(result.userMetadata).toEqual({ plan: 'pro', seats: 5 });
      });

      test('appMetadata round-trip', async () => {
        const { id } = await a().create('appmeta@example.com', 'hash');
        await a().setAppMetadata!(id, { stripeId: 'cus_123' });

        const result = await a().getUserMetadata!(id);
        expect(result.appMetadata).toEqual({ stripeId: 'cus_123' });
      });
    });
  });
}
