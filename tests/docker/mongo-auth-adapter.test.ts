import { createMongoAuthAdapter } from '@auth/adapters/mongoAuth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';

let mongoAuthAdapter: AuthAdapter;

beforeAll(async () => {
  await connectTestMongo();
  mongoAuthAdapter = createMongoAuthAdapter(getTestAuthConn(), getMongooseModule());
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe('mongoAuthAdapter', () => {
  // -----------------------------------------------------------------------
  // User CRUD
  // -----------------------------------------------------------------------

  describe('create + findByEmail', () => {
    it('creates a user and finds by email', async () => {
      const { id } = await mongoAuthAdapter.create('test@example.com', 'hashed-pw');
      expect(id).toBeTruthy();

      const found = await mongoAuthAdapter.findByEmail('test@example.com');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.passwordHash).toBe('hashed-pw');
    });

    it('returns null for non-existent email', async () => {
      const found = await mongoAuthAdapter.findByEmail('nobody@example.com');
      expect(found).toBeNull();
    });

    it('throws 409 on duplicate email', async () => {
      await mongoAuthAdapter.create('dup@example.com', 'pw1');
      try {
        await mongoAuthAdapter.create('dup@example.com', 'pw2');
        throw new Error('Expected duplicate to throw');
      } catch (err: any) {
        expect(err.message).toContain('Email already registered');
      }
    });
  });

  describe('findByIdentifier', () => {
    it('finds user by email identifier', async () => {
      const { id } = await mongoAuthAdapter.create('ident@example.com', 'pw');
      const found = await mongoAuthAdapter.findByIdentifier!('ident@example.com');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('returns null for missing identifier', async () => {
      const found = await mongoAuthAdapter.findByIdentifier!('missing@example.com');
      expect(found).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('deletes a user', async () => {
      const { id } = await mongoAuthAdapter.create('delete@example.com', 'pw');
      await mongoAuthAdapter.deleteUser!(id);
      const found = await mongoAuthAdapter.findByEmail('delete@example.com');
      expect(found).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Password
  // -----------------------------------------------------------------------

  describe('setPassword + hasPassword', () => {
    it('sets and checks password', async () => {
      const { id } = await mongoAuthAdapter.create('pw@example.com', '');
      expect(await mongoAuthAdapter.hasPassword!(id)).toBe(false);

      await mongoAuthAdapter.setPassword!(id, 'new-hashed-pw');
      expect(await mongoAuthAdapter.hasPassword!(id)).toBe(true);

      const found = await mongoAuthAdapter.findByEmail('pw@example.com');
      expect(found!.passwordHash).toBe('new-hashed-pw');
    });
  });

  // -----------------------------------------------------------------------
  // OAuth Providers
  // -----------------------------------------------------------------------

  describe('findOrCreateByProvider', () => {
    it('creates a new user for unknown provider', async () => {
      const result = await mongoAuthAdapter.findOrCreateByProvider!('google', 'gid-123', {
        email: 'oauth@example.com',
      });
      expect(result.created).toBe(true);
      expect(result.id).toBeTruthy();
    });

    it('finds existing user by provider key', async () => {
      const first = await mongoAuthAdapter.findOrCreateByProvider!('google', 'gid-456', {
        email: 'existing@example.com',
      });
      const second = await mongoAuthAdapter.findOrCreateByProvider!('google', 'gid-456', {
        email: 'existing@example.com',
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('throws 409 if email belongs to credential account', async () => {
      await mongoAuthAdapter.create('cred@example.com', 'pw');
      try {
        await mongoAuthAdapter.findOrCreateByProvider!('google', 'gid-789', {
          email: 'cred@example.com',
        });
        throw new Error('Expected 409 to throw');
      } catch (err: any) {
        expect(err.message).toContain('An account with this email already exists');
      }
    });
  });

  describe('linkProvider + unlinkProvider', () => {
    it('links and unlinks a provider', async () => {
      const { id } = await mongoAuthAdapter.create('link@example.com', 'pw');
      await mongoAuthAdapter.linkProvider!(id, 'google', 'gid-link');

      const user = await mongoAuthAdapter.getUser!(id);
      expect(user!.providerIds).toContain('google:gid-link');

      await mongoAuthAdapter.unlinkProvider!(id, 'google');
      const updated = await mongoAuthAdapter.getUser!(id);
      expect(updated!.providerIds).not.toContain('google:gid-link');
    });

    it('linkProvider is idempotent', async () => {
      const { id } = await mongoAuthAdapter.create('idempotent@example.com', 'pw');
      await mongoAuthAdapter.linkProvider!(id, 'google', 'gid-same');
      await mongoAuthAdapter.linkProvider!(id, 'google', 'gid-same');

      const user = await mongoAuthAdapter.getUser!(id);
      const count = user!.providerIds!.filter((p: string) => p === 'google:gid-same').length;
      expect(count).toBe(1);
    });

    it('throws 404 for non-existent user', async () => {
      try {
        await mongoAuthAdapter.linkProvider!('000000000000000000000000', 'google', 'gid');
        throw new Error('Expected 404 to throw');
      } catch (err: any) {
        expect(err.message).toContain('User not found');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Roles (app-wide)
  // -----------------------------------------------------------------------

  describe('roles', () => {
    it('manages app-wide roles', async () => {
      const { id } = await mongoAuthAdapter.create('roles@example.com', 'pw');

      expect(await mongoAuthAdapter.getRoles!(id)).toEqual([]);

      await mongoAuthAdapter.setRoles!(id, ['admin', 'user']);
      expect(await mongoAuthAdapter.getRoles!(id)).toEqual(['admin', 'user']);

      await mongoAuthAdapter.addRole!(id, 'editor');
      expect(await mongoAuthAdapter.getRoles!(id)).toContain('editor');

      await mongoAuthAdapter.removeRole!(id, 'admin');
      expect(await mongoAuthAdapter.getRoles!(id)).not.toContain('admin');
    });

    it('addRole is idempotent ($addToSet)', async () => {
      const { id } = await mongoAuthAdapter.create('roledup@example.com', 'pw');
      await mongoAuthAdapter.addRole!(id, 'admin');
      await mongoAuthAdapter.addRole!(id, 'admin');
      const roles = await mongoAuthAdapter.getRoles!(id);
      expect(roles.filter((r: string) => r === 'admin').length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Email verification
  // -----------------------------------------------------------------------

  describe('email verification', () => {
    it('defaults to unverified, can be toggled', async () => {
      const { id } = await mongoAuthAdapter.create('verify@example.com', 'pw');
      expect(await mongoAuthAdapter.getEmailVerified!(id)).toBe(false);

      await mongoAuthAdapter.setEmailVerified!(id, true);
      expect(await mongoAuthAdapter.getEmailVerified!(id)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getUser
  // -----------------------------------------------------------------------

  describe('getUser', () => {
    it('returns user profile', async () => {
      const { id } = await mongoAuthAdapter.create('profile@example.com', 'pw');
      const user = await mongoAuthAdapter.getUser!(id);
      expect(user).not.toBeNull();
      expect(user!.email).toBe('profile@example.com');
      expect(user!.emailVerified).toBe(false);
    });

    it('returns null for non-existent user', async () => {
      const user = await mongoAuthAdapter.getUser!('000000000000000000000000');
      expect(user).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // MFA
  // -----------------------------------------------------------------------

  describe('MFA', () => {
    it('manages MFA secret and enabled state', async () => {
      const { id } = await mongoAuthAdapter.create('mfa@example.com', 'pw');

      expect(await mongoAuthAdapter.getMfaSecret!(id)).toBeNull();
      expect(await mongoAuthAdapter.isMfaEnabled!(id)).toBe(false);

      await mongoAuthAdapter.setMfaSecret!(id, 'JBSWY3DPEHPK3PXP');
      expect(await mongoAuthAdapter.getMfaSecret!(id)).toBe('JBSWY3DPEHPK3PXP');

      await mongoAuthAdapter.setMfaEnabled!(id, true);
      expect(await mongoAuthAdapter.isMfaEnabled!(id)).toBe(true);
    });

    it('manages recovery codes', async () => {
      const { id } = await mongoAuthAdapter.create('recovery@example.com', 'pw');
      const codes = ['code1', 'code2', 'code3'];

      await mongoAuthAdapter.setRecoveryCodes!(id, codes);
      expect(await mongoAuthAdapter.getRecoveryCodes!(id)).toEqual(codes);

      await mongoAuthAdapter.removeRecoveryCode!(id, 'code2');
      expect(await mongoAuthAdapter.getRecoveryCodes!(id)).toEqual(['code1', 'code3']);
    });

    it('manages MFA methods', async () => {
      const { id } = await mongoAuthAdapter.create('methods@example.com', 'pw');

      expect(await mongoAuthAdapter.getMfaMethods!(id)).toEqual([]);

      await mongoAuthAdapter.setMfaMethods!(id, ['totp', 'email-otp']);
      expect(await mongoAuthAdapter.getMfaMethods!(id)).toEqual(['totp', 'email-otp']);
    });

    it("getMfaMethods backward compat: mfaEnabled but no methods → ['totp']", async () => {
      const { id } = await mongoAuthAdapter.create('compat@example.com', 'pw');
      await mongoAuthAdapter.setMfaEnabled!(id, true);
      // mfaMethods is empty but mfaEnabled is true
      const methods = await mongoAuthAdapter.getMfaMethods!(id);
      expect(methods).toEqual(['totp']);
    });
  });

  // -----------------------------------------------------------------------
  // WebAuthn
  // -----------------------------------------------------------------------

  describe('WebAuthn', () => {
    const cred = {
      credentialId: 'cred-abc',
      publicKey: 'pk-abc',
      signCount: 0,
      transports: ['usb'] as string[],
      name: 'My Key',
      createdAt: Date.now(),
    };

    it('adds and retrieves credentials', async () => {
      const { id } = await mongoAuthAdapter.create('webauthn@example.com', 'pw');
      await mongoAuthAdapter.addWebAuthnCredential!(id, cred);

      const creds = await mongoAuthAdapter.getWebAuthnCredentials!(id);
      expect(creds).toHaveLength(1);
      expect(creds[0].credentialId).toBe('cred-abc');
      expect(creds[0].publicKey).toBe('pk-abc');
      expect(creds[0].signCount).toBe(0);
      expect(creds[0].transports).toEqual(['usb']);
      expect(creds[0].name).toBe('My Key');
    });

    it('updates sign count', async () => {
      const { id } = await mongoAuthAdapter.create('signcount@example.com', 'pw');
      await mongoAuthAdapter.addWebAuthnCredential!(id, cred);
      await mongoAuthAdapter.updateWebAuthnCredentialSignCount!(id, 'cred-abc', 5);

      const creds = await mongoAuthAdapter.getWebAuthnCredentials!(id);
      expect(creds[0].signCount).toBe(5);
    });

    it('removes a credential', async () => {
      const { id } = await mongoAuthAdapter.create('removecred@example.com', 'pw');
      await mongoAuthAdapter.addWebAuthnCredential!(id, cred);
      await mongoAuthAdapter.removeWebAuthnCredential!(id, 'cred-abc');

      const creds = await mongoAuthAdapter.getWebAuthnCredentials!(id);
      expect(creds).toHaveLength(0);
    });

    it('finds user by credential ID', async () => {
      const { id } = await mongoAuthAdapter.create('findcred@example.com', 'pw');
      await mongoAuthAdapter.addWebAuthnCredential!(id, { ...cred, credentialId: 'cred-find' });

      const userId = await mongoAuthAdapter.findUserByWebAuthnCredentialId!('cred-find');
      expect(userId).toBe(id);
    });

    it('returns null for unknown credential ID', async () => {
      const userId = await mongoAuthAdapter.findUserByWebAuthnCredentialId!('nope');
      expect(userId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Tenant roles
  // -----------------------------------------------------------------------

  describe('tenant roles', () => {
    it('manages tenant-scoped roles', async () => {
      const { id } = await mongoAuthAdapter.create('tenant@example.com', 'pw');
      const tenantId = 'tenant-1';

      expect(await mongoAuthAdapter.getTenantRoles!(id, tenantId)).toEqual([]);

      await mongoAuthAdapter.setTenantRoles!(id, tenantId, ['admin']);
      expect(await mongoAuthAdapter.getTenantRoles!(id, tenantId)).toEqual(['admin']);

      await mongoAuthAdapter.addTenantRole!(id, tenantId, 'editor');
      expect(await mongoAuthAdapter.getTenantRoles!(id, tenantId)).toContain('editor');

      await mongoAuthAdapter.removeTenantRole!(id, tenantId, 'admin');
      const roles = await mongoAuthAdapter.getTenantRoles!(id, tenantId);
      expect(roles).not.toContain('admin');
      expect(roles).toContain('editor');
    });

    it('addTenantRole upserts for new tenant', async () => {
      const { id } = await mongoAuthAdapter.create('upsert@example.com', 'pw');
      await mongoAuthAdapter.addTenantRole!(id, 'new-tenant', 'member');
      expect(await mongoAuthAdapter.getTenantRoles!(id, 'new-tenant')).toEqual(['member']);
    });
  });
});
