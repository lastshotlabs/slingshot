import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  consumeMfaChallenge,
  consumePasskeyLoginChallenge,
  consumeWebAuthnRegistrationChallenge,
  createMemoryMfaChallengeRepository,
  createMfaChallenge,
  createPasskeyLoginChallenge,
  createWebAuthnRegistrationChallenge,
  replaceMfaChallengeOtp,
} from '@auth/lib/mfaChallenge';
import { beforeEach, describe, expect, test } from 'bun:test';

let repo: ReturnType<typeof createMemoryMfaChallengeRepository>;
let config: AuthResolvedConfig;

beforeEach(() => {
  repo = createMemoryMfaChallengeRepository();
  config = { ...DEFAULT_AUTH_CONFIG, mfa: { challengeTtlSeconds: 300 } };
});

// ---------------------------------------------------------------------------
// createMfaChallenge + consumeMfaChallenge
// ---------------------------------------------------------------------------

describe('createMfaChallenge + consumeMfaChallenge', () => {
  test('creates and consumes a login challenge', async () => {
    const token = await createMfaChallenge(repo, 'user1', undefined, config);
    const data = await consumeMfaChallenge(repo, token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe('user1');
    expect(data!.purpose).toBe('login');
  });

  test('stores emailOtpHash when provided', async () => {
    const token = await createMfaChallenge(repo, 'user1', { emailOtpHash: 'hash123' }, config);
    const data = await consumeMfaChallenge(repo, token);
    expect(data!.emailOtpHash).toBe('hash123');
  });

  test('stores webauthnChallenge when provided', async () => {
    const token = await createMfaChallenge(
      repo,
      'user1',
      { webauthnChallenge: 'challenge-xyz' },
      config,
    );
    const data = await consumeMfaChallenge(repo, token);
    expect(data!.webauthnChallenge).toBe('challenge-xyz');
  });

  test('second consume returns null (single-use)', async () => {
    const token = await createMfaChallenge(repo, 'user1', undefined, config);
    await consumeMfaChallenge(repo, token);
    expect(await consumeMfaChallenge(repo, token)).toBeNull();
  });

  test('returns null for non-existent token', async () => {
    expect(await consumeMfaChallenge(repo, 'nonexistent')).toBeNull();
  });

  test('returns null for expired token', async () => {
    config = { ...config, mfa: { challengeTtlSeconds: 1 } };
    const token = await createMfaChallenge(repo, 'user1', undefined, config);
    await Bun.sleep(1100);
    expect(await consumeMfaChallenge(repo, token)).toBeNull();
    config = { ...config, mfa: { challengeTtlSeconds: 300 } };
  });
});

// ---------------------------------------------------------------------------
// Cross-purpose rejection
// ---------------------------------------------------------------------------

describe('cross-purpose rejection', () => {
  test('consumeMfaChallenge rejects webauthn-registration purpose', async () => {
    const token = await createWebAuthnRegistrationChallenge(repo, 'user1', 'challenge-abc', config);
    const data = await consumeMfaChallenge(repo, token);
    expect(data).toBeNull();
  });

  test('consumeWebAuthnRegistrationChallenge rejects login purpose', async () => {
    const token = await createMfaChallenge(repo, 'user1', undefined, config);
    const data = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replaceMfaChallengeOtp
// ---------------------------------------------------------------------------

describe('replaceMfaChallengeOtp', () => {
  test('replaces the OTP hash on an existing challenge', async () => {
    const token = await createMfaChallenge(repo, 'user1', { emailOtpHash: 'old-hash' }, config);
    const result = await replaceMfaChallengeOtp(repo, token, 'new-hash', config);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user1');
    expect(result!.resendCount).toBe(1);

    // Verify the hash was updated by consuming
    const data = await consumeMfaChallenge(repo, token);
    expect(data!.emailOtpHash).toBe('new-hash');
  });

  test('increments resendCount on successive calls', async () => {
    const token = await createMfaChallenge(repo, 'user1', { emailOtpHash: 'h0' }, config);
    const r1 = await replaceMfaChallengeOtp(repo, token, 'h1', config);
    expect(r1!.resendCount).toBe(1);
    const r2 = await replaceMfaChallengeOtp(repo, token, 'h2', config);
    expect(r2!.resendCount).toBe(2);
    const r3 = await replaceMfaChallengeOtp(repo, token, 'h3', config);
    expect(r3!.resendCount).toBe(3);
  });

  test('returns null after MAX_RESENDS (3) exceeded', async () => {
    const token = await createMfaChallenge(repo, 'user1', { emailOtpHash: 'h0' }, config);
    await replaceMfaChallengeOtp(repo, token, 'h1', config);
    await replaceMfaChallengeOtp(repo, token, 'h2', config);
    await replaceMfaChallengeOtp(repo, token, 'h3', config);
    // 4th attempt should fail
    expect(await replaceMfaChallengeOtp(repo, token, 'h4', config)).toBeNull();
  });

  test('returns null for non-existent token', async () => {
    expect(await replaceMfaChallengeOtp(repo, 'nonexistent', 'hash', config)).toBeNull();
  });

  test('returns null for expired token', async () => {
    config = { ...config, mfa: { challengeTtlSeconds: 1 } };
    const token = await createMfaChallenge(repo, 'user1', { emailOtpHash: 'h0' }, config);
    await Bun.sleep(1100);
    expect(await replaceMfaChallengeOtp(repo, token, 'h1', config)).toBeNull();
    config = { ...config, mfa: { challengeTtlSeconds: 300 } };
  });
});

// ---------------------------------------------------------------------------
// WebAuthn registration challenges
// ---------------------------------------------------------------------------

describe('createWebAuthnRegistrationChallenge + consumeWebAuthnRegistrationChallenge', () => {
  test('creates and consumes a webauthn-registration challenge', async () => {
    const token = await createWebAuthnRegistrationChallenge(repo, 'user1', 'challenge-abc', config);
    const data = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe('user1');
    expect(data!.challenge).toBe('challenge-abc');
  });

  test('second consume returns null (single-use)', async () => {
    const token = await createWebAuthnRegistrationChallenge(repo, 'user1', 'c1', config);
    await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(await consumeWebAuthnRegistrationChallenge(repo, token)).toBeNull();
  });

  test('returns null for expired token', async () => {
    config = { ...config, mfa: { challengeTtlSeconds: 1 } };
    const token = await createWebAuthnRegistrationChallenge(repo, 'user1', 'c1', config);
    await Bun.sleep(1100);
    expect(await consumeWebAuthnRegistrationChallenge(repo, token)).toBeNull();
    config = { ...config, mfa: { challengeTtlSeconds: 300 } };
  });
});

// ---------------------------------------------------------------------------
// Passkey login challenges
// ---------------------------------------------------------------------------

describe('createPasskeyLoginChallenge + consumePasskeyLoginChallenge', () => {
  test('creates and consumes a passkey-login challenge', async () => {
    const token = await createPasskeyLoginChallenge(repo, 'challenge-abc');
    const data = await consumePasskeyLoginChallenge(repo, token);
    expect(data).not.toBeNull();
    expect(data!.webauthnChallenge).toBe('challenge-abc');
  });

  test('second consume returns null (single-use)', async () => {
    const token = await createPasskeyLoginChallenge(repo, 'challenge-abc');
    await consumePasskeyLoginChallenge(repo, token);
    expect(await consumePasskeyLoginChallenge(repo, token)).toBeNull();
  });

  test('returns null for non-existent token', async () => {
    expect(await consumePasskeyLoginChallenge(repo, 'nonexistent')).toBeNull();
  });

  test('stores the webauthnChallenge bytes correctly', async () => {
    const challenge = 'base64url-encoded-challenge-bytes';
    const token = await createPasskeyLoginChallenge(repo, challenge);
    const data = await consumePasskeyLoginChallenge(repo, token);
    expect(data!.webauthnChallenge).toBe(challenge);
  });
});

describe('passkey-login cross-purpose rejection', () => {
  test('consumeMfaChallenge rejects passkey-login token', async () => {
    const token = await createPasskeyLoginChallenge(repo, 'challenge-abc');
    const data = await consumeMfaChallenge(repo, token);
    expect(data).toBeNull();
  });

  test('consumeWebAuthnRegistrationChallenge rejects passkey-login token', async () => {
    const token = await createPasskeyLoginChallenge(repo, 'challenge-abc');
    const data = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(data).toBeNull();
  });

  test('consumePasskeyLoginChallenge rejects login-purpose token', async () => {
    const token = await createMfaChallenge(repo, 'user1', undefined, config);
    const data = await consumePasskeyLoginChallenge(repo, token);
    expect(data).toBeNull();
  });

  test('consumePasskeyLoginChallenge rejects webauthn-registration token', async () => {
    const token = await createWebAuthnRegistrationChallenge(repo, 'user1', 'challenge-abc', config);
    const data = await consumePasskeyLoginChallenge(repo, token);
    expect(data).toBeNull();
  });
});
