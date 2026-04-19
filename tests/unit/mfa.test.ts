import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthRuntimeContext } from '@auth/runtime';
import { generateEmailOtpCode, verifyEmailOtp } from '@auth/services/mfa';
import { beforeEach, describe, expect, test } from 'bun:test';

let config: AuthResolvedConfig;

function makeRuntimeCtx(): AuthRuntimeContext {
  return { config } as AuthRuntimeContext;
}

beforeEach(() => {
  // generateEmailOtpCode reads config for default code length
  config = { ...DEFAULT_AUTH_CONFIG, mfa: { emailOtp: {} } };
});

describe('generateEmailOtpCode', () => {
  test('generates a 6-digit numeric code by default', () => {
    const { code, hash } = generateEmailOtpCode(makeRuntimeCtx());
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
    expect(hash).toBeString();
    expect(hash.length).toBeGreaterThan(0);
  });

  test('generates a code of custom length', () => {
    const { code } = generateEmailOtpCode(makeRuntimeCtx(), 8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^\d{8}$/);
  });

  test('produces unique codes on successive calls', () => {
    const codes = new Set(
      Array.from({ length: 20 }, () => generateEmailOtpCode(makeRuntimeCtx()).code),
    );
    // With 6 digits and 20 samples, collisions are astronomically unlikely
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('verifyEmailOtp', () => {
  test('returns true for matching code', () => {
    const { code, hash } = generateEmailOtpCode(makeRuntimeCtx());
    expect(verifyEmailOtp(hash, code)).toBe(true);
  });

  test('returns false for wrong code', () => {
    const { hash } = generateEmailOtpCode(makeRuntimeCtx());
    expect(verifyEmailOtp(hash, '000000')).toBe(false);
  });

  test('returns false for empty code', () => {
    const { hash } = generateEmailOtpCode(makeRuntimeCtx());
    expect(verifyEmailOtp(hash, '')).toBe(false);
  });
});
