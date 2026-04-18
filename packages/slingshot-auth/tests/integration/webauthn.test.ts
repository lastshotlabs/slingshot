import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryAuthAdapter } from '../../src/adapters/memoryAuth';
import { DEFAULT_AUTH_CONFIG } from '../../src/config/authConfig';
import { createMemorySessionRepository } from '../../src/lib/session';

// ---------------------------------------------------------------------------
// WebAuthn sign count validation
// ---------------------------------------------------------------------------

describe('WebAuthn credential sign count', () => {
  let adapter: AuthAdapter;
  let userId: string;

  beforeEach(async () => {
    adapter = createMemoryAuthAdapter();
    // The memory adapter requires users to exist before credentials can be attached
    const user = await adapter.create('test@example.com', null as unknown as string);
    userId = user.id;
  });

  test('addWebAuthnCredential stores the credential with the initial sign count', async () => {
    await adapter.addWebAuthnCredential!(userId, {
      credentialId: 'cred-abc',
      publicKey: 'base64url-public-key',
      signCount: 5,
      transports: ['internal'],
      createdAt: Date.now(),
    });

    const creds = await adapter.getWebAuthnCredentials!(userId);
    expect(creds).toHaveLength(1);
    expect(creds[0].credentialId).toBe('cred-abc');
    expect(creds[0].signCount).toBe(5);
  });

  test('updateWebAuthnCredentialSignCount persists the updated count', async () => {
    await adapter.addWebAuthnCredential!(userId, {
      credentialId: 'cred-abc',
      publicKey: 'base64url-public-key',
      signCount: 5,
      createdAt: Date.now(),
    });

    // updateWebAuthnCredentialSignCount signature: (userId, credentialId, newCount)
    await adapter.updateWebAuthnCredentialSignCount!(userId, 'cred-abc', 42);

    const creds = await adapter.getWebAuthnCredentials!(userId);
    expect(creds[0].signCount).toBe(42);
  });

  test('findUserByWebAuthnCredentialId resolves the owning user ID', async () => {
    await adapter.addWebAuthnCredential!(userId, {
      credentialId: 'cred-xyz',
      publicKey: 'base64url-public-key',
      signCount: 0,
      createdAt: Date.now(),
    });

    const found = await adapter.findUserByWebAuthnCredentialId!('cred-xyz');
    expect(found).toBe(userId);

    const missing = await adapter.findUserByWebAuthnCredentialId!('does-not-exist');
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Passkey MFA bypass — session-level MFA tracking
//
// A passkey with UserVerification satisfies both the password factor and MFA.
// The session stores mfaVerifiedAt to record this. These tests verify the
// integrity of that tracking without running the full WebAuthn ceremony.
// ---------------------------------------------------------------------------

describe('passkey MFA bypass prevention', () => {
  let repo: ReturnType<typeof createMemorySessionRepository>;
  const cfg = DEFAULT_AUTH_CONFIG;

  beforeEach(() => {
    repo = createMemorySessionRepository();
  });

  test('a freshly created session has no mfaVerifiedAt (password-only login, not MFA-verified)', async () => {
    await repo.createSession('user-1', 'token-a', 'sess-a', {}, cfg);
    const ts = await repo.getMfaVerifiedAt('sess-a');
    expect(ts).toBeNull();
  });

  test('setMfaVerifiedAt marks the session as fully authenticated (passkey satisfies MFA)', async () => {
    await repo.createSession('user-1', 'token-b', 'sess-b', {}, cfg);

    const before = Math.floor(Date.now() / 1000);
    await repo.setMfaVerifiedAt('sess-b');
    const after = Math.floor(Date.now() / 1000);

    const ts = await repo.getMfaVerifiedAt('sess-b');
    expect(ts).not.toBeNull();
    // getMfaVerifiedAt returns epoch seconds
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  test('mfaVerifiedAt set on one session does not bleed into a sibling session for the same user', async () => {
    await repo.createSession('user-1', 'token-c', 'sess-c', {}, cfg);
    await repo.createSession('user-1', 'token-d', 'sess-d', {}, cfg);

    await repo.setMfaVerifiedAt('sess-c');

    // sess-d should remain unverified
    const tsD = await repo.getMfaVerifiedAt('sess-d');
    expect(tsD).toBeNull();
  });
});
