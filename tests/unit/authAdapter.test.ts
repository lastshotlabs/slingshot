import { describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// AuthAdapter type contract tests
//
// The old singleton get/setAuthAdapter functions have been removed.
// AuthAdapter is now a pure type re-exported from slingshot-core.
// These tests verify the type contract by constructing conforming objects.
// ---------------------------------------------------------------------------

describe('AuthAdapter type contract', () => {
  test('minimal adapter satisfies CoreAuthAdapter (Tier 1)', () => {
    const adapter: AuthAdapter = {
      async findByEmail() {
        return null;
      },
      async create() {
        return { id: 'test' };
      },
      async verifyPassword() {
        return false;
      },
      async getIdentifier() {
        return 'user@example.com';
      },
      async consumeRecoveryCode() {
        return false;
      },
    };
    expect(adapter.findByEmail).toBeFunction();
    expect(adapter.create).toBeFunction();
    expect(adapter.verifyPassword).toBeFunction();
    expect(adapter.getIdentifier).toBeFunction();
    expect(adapter.consumeRecoveryCode).toBeFunction();
  });

  test('findByEmail returns user record or null', async () => {
    const adapter: AuthAdapter = {
      async findByEmail(email) {
        if (email === 'found@example.com') return { id: '1', passwordHash: 'h' };
        return null;
      },
      async create() {
        return { id: '2' };
      },
      async verifyPassword() {
        return false;
      },
      async getIdentifier() {
        return '';
      },
      async consumeRecoveryCode() {
        return false;
      },
    };
    expect(await adapter.findByEmail('found@example.com')).toEqual({ id: '1', passwordHash: 'h' });
    expect(await adapter.findByEmail('missing@example.com')).toBeNull();
  });

  test('create returns object with id', async () => {
    const adapter: AuthAdapter = {
      async findByEmail() {
        return null;
      },
      async create(_email, _hash) {
        return { id: 'new-user-id' };
      },
      async verifyPassword() {
        return false;
      },
      async getIdentifier() {
        return '';
      },
      async consumeRecoveryCode() {
        return false;
      },
    };
    const result = await adapter.create('user@example.com', 'hash');
    expect(result).toEqual({ id: 'new-user-id' });
  });

  test('optional tier methods are not required', () => {
    const adapter: AuthAdapter = {
      async findByEmail() {
        return null;
      },
      async create() {
        return { id: '1' };
      },
      async verifyPassword() {
        return false;
      },
      async getIdentifier() {
        return '';
      },
      async consumeRecoveryCode() {
        return false;
      },
    };
    // Optional methods should be undefined when not provided
    expect(adapter.getUser).toBeUndefined();
    expect(adapter.setPassword).toBeUndefined();
    expect(adapter.deleteUser).toBeUndefined();
    expect(adapter.findOrCreateByProvider).toBeUndefined();
    expect(adapter.setMfaSecret).toBeUndefined();
    expect(adapter.getRoles).toBeUndefined();
  });

  test('adapter with optional OAuth tier methods', async () => {
    const adapter: AuthAdapter = {
      async findByEmail() {
        return null;
      },
      async create() {
        return { id: '1' };
      },
      async verifyPassword() {
        return false;
      },
      async getIdentifier() {
        return '';
      },
      async consumeRecoveryCode() {
        return false;
      },
      async findOrCreateByProvider(_provider, _providerId, _profile) {
        return { id: 'oauth-user', created: true };
      },
      async linkProvider() {},
      async unlinkProvider() {},
    };
    const result = await adapter.findOrCreateByProvider!('google', 'g-123', {
      email: 'user@gmail.com',
    });
    expect(result).toEqual({ id: 'oauth-user', created: true });
  });
});
