import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import {
  createMongoVerificationTokenRepository,
  createVerificationToken,
  deleteVerificationToken,
  getVerificationToken,
} from '@auth/lib/emailVerification';
import {
  consumeMfaChallenge,
  consumeWebAuthnRegistrationChallenge,
  createMfaChallenge,
  createMongoMfaChallengeRepository,
  createWebAuthnRegistrationChallenge,
  replaceMfaChallengeOtp,
} from '@auth/lib/mfaChallenge';
import { createMongoOAuthStateStore } from '@auth/lib/oauth';
import type { OAuthStateStore } from '@auth/lib/oauth';
import {
  consumeOAuthCode,
  createMongoOAuthCodeRepository,
  storeOAuthCode,
} from '@auth/lib/oauthCode';
import {
  consumeResetToken,
  createMongoResetTokenRepository,
  createResetToken,
} from '@auth/lib/resetPassword';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';

const TEST_CONFIG = {
  ...DEFAULT_AUTH_CONFIG,
  appName: 'test-app',
  emailVerification: { tokenExpiry: 300 },
  passwordReset: { tokenExpiry: 300 },
  mfa: { challengeTtlSeconds: 300 },
};

let oauthStateStore: OAuthStateStore;

beforeAll(async () => {
  await connectTestMongo();
  const conn = getTestAuthConn();
  const mg = getMongooseModule();
  oauthStateStore = createMongoOAuthStateStore(conn, mg);
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

describe('Mongo: email verification', () => {
  it('creates and retrieves a token', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoVerificationTokenRepository(conn, mg);
    const raw = await createVerificationToken(repo, 'user-1', 'test@example.com', TEST_CONFIG);
    const result = await getVerificationToken(repo, raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.email).toBe('test@example.com');
  });

  it('returns null for invalid token', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoVerificationTokenRepository(conn, mg);
    expect(await getVerificationToken(repo, 'invalid')).toBeNull();
  });

  it('deletes a token', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoVerificationTokenRepository(conn, mg);
    const raw = await createVerificationToken(repo, 'user-1', 'del@example.com', TEST_CONFIG);
    await deleteVerificationToken(repo, raw);
    expect(await getVerificationToken(repo, raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Password Reset
// ---------------------------------------------------------------------------

describe('Mongo: password reset', () => {
  it('creates and consumes a token (single-use)', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoResetTokenRepository(conn, mg);
    const raw = await createResetToken(repo, 'user-1', 'reset@example.com', TEST_CONFIG);
    const result = await consumeResetToken(repo, raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');

    expect(await consumeResetToken(repo, raw)).toBeNull();
  });

  it('returns null for invalid token', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoResetTokenRepository(conn, mg);
    expect(await consumeResetToken(repo, 'invalid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe('Mongo: OAuth code', () => {
  it('stores and consumes a code (single-use)', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoOAuthCodeRepository(conn, mg);
    const code = await storeOAuthCode(
      repo,
      {
        token: 'jwt-token',
        userId: 'user-1',
        email: 'oauth@example.com',
      },
      [],
    );
    const result = await consumeOAuthCode(repo, code, []);
    expect(result).not.toBeNull();
    expect(result!.token).toBe('jwt-token');

    expect(await consumeOAuthCode(repo, code, [])).toBeNull();
  });

  it('returns null for invalid code', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoOAuthCodeRepository(conn, mg);
    expect(await consumeOAuthCode(repo, 'invalid', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MFA Challenge
// ---------------------------------------------------------------------------

describe('Mongo: MFA challenge', () => {
  it('creates and consumes a login challenge', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createMfaChallenge(
      repo,
      'user-1',
      { emailOtpHash: 'hash-abc' },
      TEST_CONFIG,
    );
    const result = await consumeMfaChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.emailOtpHash).toBe('hash-abc');
  });

  it('consume is single-use', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createMfaChallenge(repo, 'user-1', undefined, TEST_CONFIG);
    await consumeMfaChallenge(repo, token);
    expect(await consumeMfaChallenge(repo, token)).toBeNull();
  });

  it('replaces OTP hash (resend)', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createMfaChallenge(repo, 'user-1', { emailOtpHash: 'hash-1' }, TEST_CONFIG);
    const result = await replaceMfaChallengeOtp(repo, token, 'hash-2', TEST_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.resendCount).toBe(1);
  });

  it('caps resends at 3', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createMfaChallenge(repo, 'user-1', { emailOtpHash: 'h' }, TEST_CONFIG);
    await replaceMfaChallengeOtp(repo, token, 'h2', TEST_CONFIG);
    await replaceMfaChallengeOtp(repo, token, 'h3', TEST_CONFIG);
    await replaceMfaChallengeOtp(repo, token, 'h4', TEST_CONFIG);
    expect(await replaceMfaChallengeOtp(repo, token, 'h5', TEST_CONFIG)).toBeNull();
  });
});

describe('Mongo: WebAuthn registration challenge', () => {
  it('creates and consumes', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createWebAuthnRegistrationChallenge(
      repo,
      'user-1',
      'challenge-data',
      TEST_CONFIG,
    );
    const result = await consumeWebAuthnRegistrationChallenge(repo, token);
    expect(result).not.toBeNull();
    expect(result!.challenge).toBe('challenge-data');
  });

  it('login consume rejects webauthn-registration tokens', async () => {
    const conn = getTestAuthConn();
    const mg = getMongooseModule();
    const repo = createMongoMfaChallengeRepository(conn, mg);
    const token = await createWebAuthnRegistrationChallenge(
      repo,
      'user-1',
      'challenge',
      TEST_CONFIG,
    );
    expect(await consumeMfaChallenge(repo, token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe('Mongo: OAuth state', () => {
  it('stores and consumes state', async () => {
    await oauthStateStore.store('state-abc', 'code-verifier-1', undefined);
    const result = await oauthStateStore.consume('state-abc');
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe('code-verifier-1');
  });

  it('state is single-use', async () => {
    await oauthStateStore.store('state-single', undefined, 'link-user-1');
    await oauthStateStore.consume('state-single');
    expect(await oauthStateStore.consume('state-single')).toBeNull();
  });

  it('stores linkUserId', async () => {
    await oauthStateStore.store('state-link', undefined, 'link-user-id');
    const result = await oauthStateStore.consume('state-link');
    expect(result!.linkUserId).toBe('link-user-id');
  });
});
