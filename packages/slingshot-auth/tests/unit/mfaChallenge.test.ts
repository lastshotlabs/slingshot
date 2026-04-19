import { describe, expect, test } from 'bun:test';
import {
  consumeMfaChallenge,
  consumePasskeyLoginChallenge,
  consumeReauthChallenge,
  consumeWebAuthnRegistrationChallenge,
  createMemoryMfaChallengeRepository,
  createMfaChallenge,
  createPasskeyLoginChallenge,
  createReauthChallenge,
  createWebAuthnRegistrationChallenge,
  replaceMfaChallengeOtp,
} from '../../src/lib/mfaChallenge';

// ---------------------------------------------------------------------------
// createMfaChallenge + consumeMfaChallenge
// ---------------------------------------------------------------------------

describe('createMfaChallenge / consumeMfaChallenge', () => {
  test('creates a challenge and consumes it with correct userId', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1');

    const result = await consumeMfaChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.purpose).toBe('login');
  });

  test('challenge token is single-use — second consume returns null', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1');

    await consumeMfaChallenge(repo, token);
    const second = await consumeMfaChallenge(repo, token);
    expect(second).toBeNull();
  });

  test('consuming a bogus token returns null', async () => {
    const repo = createMemoryMfaChallengeRepository();
    await createMfaChallenge(repo, 'user-1');

    const result = await consumeMfaChallenge(repo, 'not-a-real-token');
    expect(result).toBeNull();
  });

  test('challenge preserves emailOtpHash when provided', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1', {
      emailOtpHash: 'hash-abc',
    });

    const result = await consumeMfaChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.emailOtpHash).toBe('hash-abc');
  });

  test('challenge preserves webauthnChallenge when provided', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1', {
      webauthnChallenge: 'challenge-bytes-b64',
    });

    const result = await consumeMfaChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.webauthnChallenge).toBe('challenge-bytes-b64');
  });

  test('each call produces a unique token', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const t1 = await createMfaChallenge(repo, 'user-1');
    const t2 = await createMfaChallenge(repo, 'user-1');
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// replaceMfaChallengeOtp
// ---------------------------------------------------------------------------

describe('replaceMfaChallengeOtp', () => {
  test('replaces the OTP hash on an existing challenge', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1', {
      emailOtpHash: 'old-hash',
    });

    const result = await replaceMfaChallengeOtp(repo, token, 'new-hash');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.resendCount).toBe(1);

    // Consuming now should see the new hash
    const consumed = await consumeMfaChallenge(repo, token);
    expect(consumed).not.toBeNull();
    expect(consumed!.emailOtpHash).toBe('new-hash');
  });

  test('returns null after MAX_RESENDS (3) replacements', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createMfaChallenge(repo, 'user-1', {
      emailOtpHash: 'hash-0',
    });

    await replaceMfaChallengeOtp(repo, token, 'hash-1');
    await replaceMfaChallengeOtp(repo, token, 'hash-2');
    await replaceMfaChallengeOtp(repo, token, 'hash-3');

    const fourth = await replaceMfaChallengeOtp(repo, token, 'hash-4');
    expect(fourth).toBeNull();
  });

  test('returns null for a bogus token', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const result = await replaceMfaChallengeOtp(repo, 'no-such-token', 'new-hash');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createReauthChallenge / consumeReauthChallenge
// ---------------------------------------------------------------------------

describe('createReauthChallenge / consumeReauthChallenge', () => {
  test('creates and consumes a reauth challenge with correct fields', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createReauthChallenge(repo, 'user-1', 'session-abc', {
      emailOtpHash: 'otp-hash',
    });

    const result = await consumeReauthChallenge(repo, token, 'session-abc');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.purpose).toBe('reauth');
    expect(result!.sessionId).toBe('session-abc');
    expect(result!.emailOtpHash).toBe('otp-hash');
  });

  test('reauth challenge is single-use', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createReauthChallenge(repo, 'user-1', 'session-abc');

    await consumeReauthChallenge(repo, token, 'session-abc');
    const second = await consumeReauthChallenge(repo, token, 'session-abc');
    expect(second).toBeNull();
  });

  test('reauth challenge rejects mismatched sessionId', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createReauthChallenge(repo, 'user-1', 'session-abc');

    const result = await consumeReauthChallenge(repo, token, 'session-wrong');
    expect(result).toBeNull();
  });

  test('consumeMfaChallenge rejects reauth-purpose tokens', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createReauthChallenge(repo, 'user-1', 'session-abc');

    // consumeMfaChallenge filters purpose === 'login'
    const result = await consumeMfaChallenge(repo, token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createWebAuthnRegistrationChallenge / consumeWebAuthnRegistrationChallenge
// ---------------------------------------------------------------------------

describe('createWebAuthnRegistrationChallenge / consumeWebAuthnRegistrationChallenge', () => {
  test('creates and consumes a webauthn registration challenge', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'webauthn-bytes');

    const result = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.challenge).toBe('webauthn-bytes');
  });

  test('webauthn registration challenge is single-use', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'webauthn-bytes');

    await consumeWebAuthnRegistrationChallenge(repo, token);
    const second = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(second).toBeNull();
  });

  test('consumeMfaChallenge rejects webauthn-registration-purpose tokens', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'bytes');

    const result = await consumeMfaChallenge(repo, token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createPasskeyLoginChallenge / consumePasskeyLoginChallenge
// ---------------------------------------------------------------------------

describe('createPasskeyLoginChallenge / consumePasskeyLoginChallenge', () => {
  test('creates and consumes a passkey login challenge', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createPasskeyLoginChallenge(repo, 'passkey-challenge-b64');

    const result = await consumePasskeyLoginChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.webauthnChallenge).toBe('passkey-challenge-b64');
  });

  test('passkey login challenge is single-use', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createPasskeyLoginChallenge(repo, 'passkey-challenge-b64');

    await consumePasskeyLoginChallenge(repo, token);
    const second = await consumePasskeyLoginChallenge(repo, token);
    expect(second).toBeNull();
  });

  test('consumeMfaChallenge rejects passkey-login-purpose tokens', async () => {
    const repo = createMemoryMfaChallengeRepository();
    const token = await createPasskeyLoginChallenge(repo, 'passkey-bytes');

    const result = await consumeMfaChallenge(repo, token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-type isolation
// ---------------------------------------------------------------------------

describe('challenge type isolation', () => {
  test('consuming one challenge type does not affect another', async () => {
    const repo = createMemoryMfaChallengeRepository();

    const loginToken = await createMfaChallenge(repo, 'user-1');
    const webauthnToken = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'wa-bytes');
    const passkeyToken = await createPasskeyLoginChallenge(repo, 'pk-bytes');
    const reauthToken = await createReauthChallenge(repo, 'user-1', 'session-1');

    // Consume login — others should still be valid
    await consumeMfaChallenge(repo, loginToken);

    const wa = await consumeWebAuthnRegistrationChallenge(repo, webauthnToken);
    expect(wa).not.toBeNull();

    const pk = await consumePasskeyLoginChallenge(repo, passkeyToken);
    expect(pk).not.toBeNull();

    const ra = await consumeReauthChallenge(repo, reauthToken, 'session-1');
    expect(ra).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL / expiry
// ---------------------------------------------------------------------------

describe('challenge TTL', () => {
  test('challenge expires after TTL elapses', async () => {
    const repo = createMemoryMfaChallengeRepository();
    // Use a very short TTL via config override
    const mfaConfigPartial = { mfa: { challengeTtlSeconds: 0 } };
    const token = await createMfaChallenge(repo, 'user-1', undefined, mfaConfigPartial as import('../../src/config/authConfig').AuthResolvedConfig);

    // TTL of 0 seconds means expiresAt = Date.now() + 0 => already expired
    // The memory repo checks expiresAt <= Date.now()
    // We need a tiny delay so Date.now() advances past the expiresAt
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = await consumeMfaChallenge(repo, token);
    expect(result).toBeNull();
  });
});
