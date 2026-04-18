import { describe, expect, test } from 'bun:test';
import { createAuthResolvedConfig } from '../../src/config/authConfig';
import {
  getAuthCookieOptions,
  getCsrfCookieOptions,
  getSecureCookieName,
} from '../../src/lib/cookieOptions';

const defaultConfig = createAuthResolvedConfig({});

describe('getSecureCookieName', () => {
  test('__Host- prefix in production', () => {
    expect(getSecureCookieName('session', true, defaultConfig)).toBe('__Host-session');
  });

  test('no prefix in development', () => {
    expect(getSecureCookieName('session', false, defaultConfig)).toBe('session');
  });

  test('no prefix when domain is set', () => {
    const config = createAuthResolvedConfig({ authCookie: { domain: '.example.com' } });
    expect(getSecureCookieName('session', true, config)).toBe('session');
  });

  test('no prefix when path is not /', () => {
    const config = createAuthResolvedConfig({ authCookie: { path: '/api' } });
    expect(getSecureCookieName('session', true, config)).toBe('session');
  });
});

describe('getAuthCookieOptions', () => {
  test('httpOnly is always true', () => {
    expect(getAuthCookieOptions(true, defaultConfig).httpOnly).toBe(true);
    expect(getAuthCookieOptions(false, defaultConfig).httpOnly).toBe(true);
  });

  test('secure is true in production', () => {
    expect(getAuthCookieOptions(true, defaultConfig).secure).toBe(true);
  });

  test('secure is false in development', () => {
    expect(getAuthCookieOptions(false, defaultConfig).secure).toBe(false);
  });

  test('sameSite defaults to Lax', () => {
    expect(getAuthCookieOptions(true, defaultConfig).sameSite).toBe('Lax');
  });

  test('custom maxAge override', () => {
    expect(getAuthCookieOptions(true, defaultConfig, 3600).maxAge).toBe(3600);
  });

  test('default maxAge is 7 days', () => {
    expect(getAuthCookieOptions(true, defaultConfig).maxAge).toBe(60 * 60 * 24 * 7);
  });
});

describe('getCsrfCookieOptions', () => {
  test('httpOnly is always false', () => {
    expect(getCsrfCookieOptions(true, defaultConfig).httpOnly).toBe(false);
    expect(getCsrfCookieOptions(false, defaultConfig).httpOnly).toBe(false);
  });

  test('maxAge is 1 year (31536000 seconds)', () => {
    expect(getCsrfCookieOptions(true, defaultConfig).maxAge).toBe(31536000);
  });

  test('secure is true in production', () => {
    expect(getCsrfCookieOptions(true, defaultConfig).secure).toBe(true);
  });

  test('secure is false in development', () => {
    expect(getCsrfCookieOptions(false, defaultConfig).secure).toBe(false);
  });

  test('sameSite defaults to Lax', () => {
    expect(getCsrfCookieOptions(true, defaultConfig).sameSite).toBe('Lax');
  });
});
