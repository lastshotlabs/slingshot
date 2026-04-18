import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  createAuthRateLimitService,
  createRedisAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import type { AuthRateLimitService } from '@auth/lib/authRateLimit';
import {
  createRedisVerificationTokenRepository,
  createVerificationToken,
  deleteVerificationToken,
  getVerificationToken,
} from '@auth/lib/emailVerification';
import {
  consumeMfaChallenge,
  consumeWebAuthnRegistrationChallenge,
  createMfaChallenge,
  createRedisMfaChallengeRepository,
  createWebAuthnRegistrationChallenge,
  replaceMfaChallengeOtp,
} from '@auth/lib/mfaChallenge';
import { createRedisOAuthStateStore } from '@auth/lib/oauth';
import type { OAuthStateStore } from '@auth/lib/oauth';
import {
  consumeOAuthCode,
  createRedisOAuthCodeRepository,
  storeOAuthCode,
} from '@auth/lib/oauthCode';
import {
  consumeResetToken,
  createRedisResetTokenRepository,
  createResetToken,
} from '@auth/lib/resetPassword';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  connectTestRedis,
  disconnectTestServices,
  flushTestServices,
  getTestRedis,
} from '../setup-docker';

const defaultConfig = { ...DEFAULT_AUTH_CONFIG, appName: 'test-app' };

beforeAll(async () => {
  await connectTestRedis();
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

// ---------------------------------------------------------------------------
// Email Verification
// ---------------------------------------------------------------------------

describe('Redis: email verification', () => {
  it('creates and retrieves a token', async () => {
    const repo = createRedisVerificationTokenRepository(() => getTestRedis(), 'test-app');
    const raw = await createVerificationToken(repo, 'user-1', 'test@example.com', defaultConfig);
    const result = await getVerificationToken(repo, raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.email).toBe('test@example.com');
  });

  it('returns null for invalid token', async () => {
    const repo = createRedisVerificationTokenRepository(() => getTestRedis(), 'test-app');
    expect(await getVerificationToken(repo, 'invalid')).toBeNull();
  });

  it('deletes a token', async () => {
    const repo = createRedisVerificationTokenRepository(() => getTestRedis(), 'test-app');
    const raw = await createVerificationToken(repo, 'user-1', 'del@example.com', defaultConfig);
    await deleteVerificationToken(repo, raw);
    expect(await getVerificationToken(repo, raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Password Reset
// ---------------------------------------------------------------------------

describe('Redis: password reset', () => {
  it('creates and consumes a token (single-use)', async () => {
    const repo = createRedisResetTokenRepository(() => getTestRedis(), 'test-app');
    const raw = await createResetToken(repo, 'user-1', 'reset@example.com', defaultConfig);
    const result = await consumeResetToken(repo, raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.email).toBe('reset@example.com');

    // Second consume should return null (single-use)
    expect(await consumeResetToken(repo, raw)).toBeNull();
  });

  it('returns null for invalid token', async () => {
    const repo = createRedisResetTokenRepository(() => getTestRedis(), 'test-app');
    expect(await consumeResetToken(repo, 'invalid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe('Redis: OAuth code', () => {
  it('stores and consumes a code (single-use)', async () => {
    const repo = createRedisOAuthCodeRepository(() => getTestRedis(), 'test-app');
    const code = await storeOAuthCode(
      repo,
      {
        token: 'jwt-token',
        userId: 'user-1',
        email: 'oauth@example.com',
        refreshToken: 'rt-1',
      },
      [],
    );
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('jwt-token');
    expect(result!.userId).toBe('user-1');
    expect(result!.email).toBe('oauth@example.com');
    expect(result!.refreshToken).toBe('rt-1');

    // Single-use
    expect(await consumeOAuthCode(repo, code, [])).toBeNull();
  });

  it('returns null for invalid code', async () => {
    const repo = createRedisOAuthCodeRepository(() => getTestRedis(), 'test-app');
    expect(await consumeOAuthCode(repo, 'invalid', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MFA Challenge
// ---------------------------------------------------------------------------

describe('Redis: MFA challenge', () => {
  it('creates and consumes a login challenge', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createMfaChallenge(repo, 'user-1', { emailOtpHash: 'hash-abc' });
    const result = await consumeMfaChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.purpose).toBe('login');
    expect(result!.emailOtpHash).toBe('hash-abc');
  });

  it('consume is single-use', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createMfaChallenge(repo, 'user-1');
    await consumeMfaChallenge(repo, token);
    expect(await consumeMfaChallenge(repo, token)).toBeNull();
  });

  it('returns null for invalid token', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    expect(await consumeMfaChallenge(repo, 'nope')).toBeNull();
  });

  it('creates challenge with webauthn data', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createMfaChallenge(repo, 'user-1', { webauthnChallenge: 'challenge-xyz' });
    const result = await consumeMfaChallenge(repo, token);
    expect(result!.webauthnChallenge).toBe('challenge-xyz');
  });

  it('replaces OTP hash (resend)', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createMfaChallenge(repo, 'user-1', { emailOtpHash: 'hash-1' });
    const result = await replaceMfaChallengeOtp(repo, token, 'hash-2');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.resendCount).toBe(1);

    // Consume should get the new OTP hash
    const consumed = await consumeMfaChallenge(repo, token);
    expect(consumed!.emailOtpHash).toBe('hash-2');
  });

  it('caps resends at 3', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createMfaChallenge(repo, 'user-1', { emailOtpHash: 'h' });
    await replaceMfaChallengeOtp(repo, token, 'h2');
    await replaceMfaChallengeOtp(repo, token, 'h3');
    await replaceMfaChallengeOtp(repo, token, 'h4');
    const result = await replaceMfaChallengeOtp(repo, token, 'h5');
    expect(result).toBeNull();
  });

  it('returns null for expired/invalid resend', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    expect(await replaceMfaChallengeOtp(repo, 'nonexistent', 'h')).toBeNull();
  });
});

describe('Redis: WebAuthn registration challenge', () => {
  it('creates and consumes a webauthn-registration challenge', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createWebAuthnRegistrationChallenge(
      repo,
      'user-1',
      'webauthn-challenge-data',
    );
    const result = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.challenge).toBe('webauthn-challenge-data');
  });

  it('login consume rejects webauthn-registration tokens', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'challenge');
    const result = await consumeMfaChallenge(repo, token);
    expect(result).toBeNull();
  });

  it('is single-use', async () => {
    const repo = createRedisMfaChallengeRepository(() => getTestRedis(), 'test-app');
    const token = await createWebAuthnRegistrationChallenge(repo, 'user-1', 'challenge');
    await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(await consumeWebAuthnRegistrationChallenge(repo, token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth Rate Limit
// ---------------------------------------------------------------------------

describe('Redis: auth rate limit', () => {
  const opts = { windowMs: 60_000, max: 3 };
  let rl: AuthRateLimitService;

  beforeEach(() => {
    const repo = createRedisAuthRateLimitRepository(() => getTestRedis(), 'test-app');
    rl = createAuthRateLimitService(repo);
  });

  it('tracks attempts and limits', async () => {
    expect(await rl.isLimited('key-1', opts)).toBe(false);

    await rl.trackAttempt('key-1', opts);
    await rl.trackAttempt('key-1', opts);
    expect(await rl.isLimited('key-1', opts)).toBe(false);

    const limited = await rl.trackAttempt('key-1', opts);
    expect(limited).toBe(true);
    expect(await rl.isLimited('key-1', opts)).toBe(true);
  });

  it('busts a rate limit', async () => {
    await rl.trackAttempt('key-bust', opts);
    await rl.trackAttempt('key-bust', opts);
    await rl.trackAttempt('key-bust', opts);
    expect(await rl.isLimited('key-bust', opts)).toBe(true);

    await rl.bustAuthLimit('key-bust');
    expect(await rl.isLimited('key-bust', opts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe('Redis: OAuth state', () => {
  let store: OAuthStateStore;

  beforeEach(() => {
    store = createRedisOAuthStateStore(() => getTestRedis(), 'test-app');
  });

  it('stores and consumes state', async () => {
    await store.store('state-abc', 'code-verifier-1', undefined);
    const result = await store.consume('state-abc');
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe('code-verifier-1');
  });

  it('state is single-use', async () => {
    await store.store('state-single', undefined, 'link-user-1');
    await store.consume('state-single');
    expect(await store.consume('state-single')).toBeNull();
  });

  it('returns null for invalid state', async () => {
    expect(await store.consume('invalid')).toBeNull();
  });

  it('stores linkUserId', async () => {
    await store.store('state-link', undefined, 'link-user-id');
    const result = await store.consume('state-link');
    expect(result!.linkUserId).toBe('link-user-id');
  });
});
