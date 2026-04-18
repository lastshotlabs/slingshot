import {
  confirmEmailOtp,
  disableEmailOtp,
  disableMfa,
  generateEmailOtpCode,
  getMfaMethods,
  initiateEmailOtp,
  regenerateRecoveryCodes,
  setupMfa,
  verifyEmailOtp,
  verifyRecoveryCode,
  verifySetup,
  verifyTotp,
} from '@auth/services/mfa';
import { beforeEach, describe, expect, test } from 'bun:test';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

let app: any;
let adapter: ReturnType<typeof getAuthRuntimeContext>['adapter'];
const emailOtpCodes: { email: string; code: string }[] = [];
const getRuntime = () => getAuthRuntimeContext(getContext(app));

const emailOtpHandler = (payload: { email: string; code: string }) => {
  emailOtpCodes.push({ email: payload.email, code: payload.code });
};

beforeEach(async () => {
  emailOtpCodes.length = 0;
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        mfa: {
          challengeTtlSeconds: 300,
          emailOtp: {},
        },
      },
    },
  );
  adapter = getRuntime().adapter;
  getContext(app).bus.off('auth:delivery.email_otp', emailOtpHandler);
  getContext(app).bus.on('auth:delivery.email_otp', emailOtpHandler);
});

async function createUser(email = 'mfa@example.com', password = 'password123') {
  const user = await adapter.create(email, await Bun.password.hash(password));
  return user.id;
}

// Helper: get a valid TOTP code for a user
async function getValidTotp(userId: string): Promise<string> {
  const otpauth = await import('otpauth');
  const secretStr = await adapter.getMfaSecret!(userId);
  const totp = new otpauth.TOTP({
    secret: otpauth.Secret.fromBase32(secretStr!),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

// ---------------------------------------------------------------------------
// TOTP setup + management
// ---------------------------------------------------------------------------

describe('setupMfa', () => {
  test('returns secret and URI', async () => {
    const userId = await createUser();
    const result = await setupMfa(userId, getRuntime());
    expect(result.secret).toBeTruthy();
    expect(result.uri).toContain('otpauth://totp/');
  });
});

describe('verifySetup', () => {
  test('valid TOTP code enables MFA and returns recovery codes', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code, getRuntime());
    expect(recoveryCodes).toBeArray();
    expect(recoveryCodes.length).toBe(10);
    expect(await adapter.isMfaEnabled!(userId)).toBe(true);
  });

  test('invalid code throws 401', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    expect(verifySetup(userId, '000000', getRuntime())).rejects.toThrow('Invalid TOTP code');
  });

  test("adds 'totp' to mfaMethods", async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).toContain('totp');
  });
});

describe('verifyTotp', () => {
  test('returns true for valid code', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    const freshCode = await getValidTotp(userId);
    expect(await verifyTotp(userId, freshCode, getRuntime())).toBe(true);
  });

  test('returns false for invalid code', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    expect(await verifyTotp(userId, '000000', getRuntime())).toBe(false);
  });
});

describe('verifyRecoveryCode', () => {
  test('valid code is consumed and returns true', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code, getRuntime());
    const firstCode = recoveryCodes[0];
    expect(await verifyRecoveryCode(userId, firstCode, getRuntime())).toBe(true);
  });

  test('already-used code returns false', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code, getRuntime());
    const firstCode = recoveryCodes[0];
    await verifyRecoveryCode(userId, firstCode, getRuntime());
    expect(await verifyRecoveryCode(userId, firstCode, getRuntime())).toBe(false);
  });

  test('invalid code returns false', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    expect(await verifyRecoveryCode(userId, 'INVALIDCODE', getRuntime())).toBe(false);
  });
});

describe('disableMfa', () => {
  test('clears MFA with valid TOTP code', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    const disableCode = await getValidTotp(userId);
    await disableMfa(userId, disableCode, getRuntime());
    expect(await adapter.isMfaEnabled!(userId)).toBe(false);
  });

  test('rejects invalid TOTP code', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    expect(disableMfa(userId, '000000', getRuntime())).rejects.toThrow('Invalid TOTP code');
  });
});

describe('regenerateRecoveryCodes', () => {
  test('returns new recovery codes with valid TOTP', async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    const oldCodes = await verifySetup(userId, code, getRuntime());
    const regenCode = await getValidTotp(userId);
    const newCodes = await regenerateRecoveryCodes(userId, regenCode, getRuntime());
    expect(newCodes).toBeArray();
    expect(newCodes.length).toBe(10);
    // New codes should differ from old
    expect(newCodes[0]).not.toBe(oldCodes[0]);
  });
});

describe('getMfaMethods', () => {
  test('returns empty array for user with no MFA', async () => {
    const userId = await createUser();
    expect(await getMfaMethods(userId, getRuntime())).toEqual([]);
  });

  test("returns ['totp'] when TOTP enabled", async () => {
    const userId = await createUser();
    await setupMfa(userId, getRuntime());
    const code = await getValidTotp(userId);
    await verifySetup(userId, code, getRuntime());
    expect(await getMfaMethods(userId, getRuntime())).toEqual(['totp']);
  });
});

// ---------------------------------------------------------------------------
// Email OTP
// ---------------------------------------------------------------------------

describe('generateEmailOtpCode', () => {
  test('generates a code of the configured length', () => {
    const { code, hash } = generateEmailOtpCode(getRuntime(), 6);
    expect(code).toHaveLength(6);
    expect(/^\d+$/.test(code)).toBe(true);
    expect(hash).toBeTruthy();
  });
});

describe('verifyEmailOtp', () => {
  test('returns true for matching code', () => {
    const { code, hash } = generateEmailOtpCode(getRuntime());
    expect(verifyEmailOtp(hash, code)).toBe(true);
  });

  test('returns false for wrong code', () => {
    const { hash } = generateEmailOtpCode(getRuntime());
    expect(verifyEmailOtp(hash, '000000')).toBe(false);
  });
});

describe('initiateEmailOtp', () => {
  test('emits email_otp delivery event and returns challenge token', async () => {
    const userId = await createUser('emailotp@example.com');
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    expect(typeof setupToken).toBe('string');
    expect(emailOtpCodes).toHaveLength(1);
    expect(emailOtpCodes[0].email).toBe('emailotp@example.com');
    expect(emailOtpCodes[0].code).toBeTruthy();
  });
});

describe('confirmEmailOtp', () => {
  test('enables email OTP method and returns recovery codes', async () => {
    const userId = await createUser('confirm@example.com');
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    const code = emailOtpCodes[0].code;
    const recoveryCodes = await confirmEmailOtp(userId, setupToken, code, getRuntime());
    expect(recoveryCodes).toBeArray();
    expect(recoveryCodes!.length).toBe(10);
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).toContain('emailOtp');
    expect(await adapter.isMfaEnabled!(userId)).toBe(true);
  });

  test('rejects invalid code', async () => {
    const userId = await createUser('bad@example.com');
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    expect(confirmEmailOtp(userId, setupToken, '000000', getRuntime())).rejects.toThrow(
      'Invalid verification code',
    );
  });

  test('rejects expired/invalid setup token', async () => {
    const userId = await createUser('expired@example.com');
    expect(confirmEmailOtp(userId, 'invalid-token', '123456', getRuntime())).rejects.toThrow(
      'Invalid or expired setup token',
    );
  });
});

describe('disableEmailOtp', () => {
  test('removes email OTP method with password verification', async () => {
    const userId = await createUser('disable@example.com', 'password123');
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    const code = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, code, getRuntime());
    await disableEmailOtp(userId, { password: 'password123' }, getRuntime());
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).not.toContain('emailOtp');
  });

  test('disables MFA entirely when last method removed', async () => {
    const userId = await createUser('lastmethod@example.com', 'password123');
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    const code = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, code, getRuntime());
    await disableEmailOtp(userId, { password: 'password123' }, getRuntime());
    expect(await adapter.isMfaEnabled!(userId)).toBe(false);
  });

  test('requires TOTP code when TOTP is also enabled', async () => {
    const userId = await createUser('both@example.com', 'password123');
    // Enable TOTP first
    await setupMfa(userId, getRuntime());
    const totpCode = await getValidTotp(userId);
    await verifySetup(userId, totpCode, getRuntime());
    // Enable email OTP
    const setupToken = await initiateEmailOtp(userId, getRuntime());
    const otpCode = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, otpCode, getRuntime());
    // Disable email OTP requires TOTP code
    const disableCode = await getValidTotp(userId);
    await disableEmailOtp(userId, { code: disableCode }, getRuntime());
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).not.toContain('emailOtp');
    expect(methods).toContain('totp');
  });
});
