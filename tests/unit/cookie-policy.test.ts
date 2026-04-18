import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { getAuthCookieOptions, getCsrfCookieOptions } from '@auth/lib/cookieOptions';
import { beforeEach, describe, expect, test } from 'bun:test';

let config: AuthResolvedConfig;

beforeEach(() => {
  // Reset to defaults before each test
  config = { ...DEFAULT_AUTH_CONFIG };
});

describe('getAuthCookieOptions', () => {
  test('defaults match previously hardcoded values (non-production)', () => {
    const opts = getAuthCookieOptions(false, config);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(false);
    expect(opts.sameSite).toBe('Lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(60 * 60 * 24 * 7); // 7 days
    expect(opts.domain).toBeUndefined();
  });

  test('defaults match previously hardcoded values (production)', () => {
    const opts = getAuthCookieOptions(true, config);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('Lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(60 * 60 * 24 * 7); // 7 days
  });

  test('httpOnly is always true regardless of config', () => {
    // httpOnly is not configurable for auth cookies
    const opts = getAuthCookieOptions(false, config);
    expect(opts.httpOnly).toBe(true);
  });

  test('custom sameSite override', () => {
    config = { ...config, authCookie: { sameSite: 'Strict' } };
    const opts = getAuthCookieOptions(false, config);
    expect(opts.sameSite).toBe('Strict');
  });

  test('custom domain override', () => {
    config = { ...config, authCookie: { domain: 'example.com' } };
    const opts = getAuthCookieOptions(false, config);
    expect(opts.domain).toBe('example.com');
  });

  test('custom maxAge override', () => {
    config = { ...config, authCookie: { maxAge: 3600 } };
    const opts = getAuthCookieOptions(false, config);
    expect(opts.maxAge).toBe(3600);
  });

  test('explicit maxAge parameter overrides config maxAge', () => {
    config = { ...config, authCookie: { maxAge: 3600 } };
    const opts = getAuthCookieOptions(false, config, 900);
    expect(opts.maxAge).toBe(900);
  });

  test('explicit maxAge=undefined falls back to config maxAge', () => {
    config = { ...config, authCookie: { maxAge: 3600 } };
    const opts = getAuthCookieOptions(false, config, undefined);
    expect(opts.maxAge).toBe(3600);
  });

  test('custom secure override (force true in dev)', () => {
    config = { ...config, authCookie: { secure: true } };
    const opts = getAuthCookieOptions(false, config);
    expect(opts.secure).toBe(true);
  });

  test('custom path override', () => {
    config = { ...config, authCookie: { path: '/api' } };
    const opts = getAuthCookieOptions(false, config);
    expect(opts.path).toBe('/api');
  });
});

describe('getCsrfCookieOptions', () => {
  test('defaults match previously hardcoded values (non-production)', () => {
    const opts = getCsrfCookieOptions(false, config);
    expect(opts.httpOnly).toBe(false);
    expect(opts.secure).toBe(false);
    expect(opts.sameSite).toBe('Lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(60 * 60 * 24 * 365); // 1 year
    expect(opts.domain).toBeUndefined();
  });

  test('defaults match previously hardcoded values (production)', () => {
    const opts = getCsrfCookieOptions(true, config);
    expect(opts.httpOnly).toBe(false);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('Lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(60 * 60 * 24 * 365); // 1 year
  });

  test('httpOnly is always false regardless of config', () => {
    // httpOnly is not configurable for CSRF cookies (JS must read it)
    const opts = getCsrfCookieOptions(false, config);
    expect(opts.httpOnly).toBe(false);
  });

  test('custom sameSite override', () => {
    config = { ...config, csrfCookie: { sameSite: 'Strict' } };
    const opts = getCsrfCookieOptions(false, config);
    expect(opts.sameSite).toBe('Strict');
  });

  test('custom domain override', () => {
    config = { ...config, csrfCookie: { domain: 'example.com' } };
    const opts = getCsrfCookieOptions(false, config);
    expect(opts.domain).toBe('example.com');
  });

  test('custom maxAge override', () => {
    config = { ...config, csrfCookie: { maxAge: 86400 } };
    const opts = getCsrfCookieOptions(false, config);
    expect(opts.maxAge).toBe(86400);
  });

  test('auth httpOnly=true and csrf httpOnly=false are always distinct', () => {
    const authOpts = getAuthCookieOptions(false, config);
    const csrfOpts = getCsrfCookieOptions(false, config);
    expect(authOpts.httpOnly).toBe(true);
    expect(csrfOpts.httpOnly).toBe(false);
  });
});
