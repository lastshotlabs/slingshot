import { describe, expect, test } from 'bun:test';
import { getClientIp, setStandaloneTrustProxy } from '@lastshotlabs/slingshot-core';

function mockContext(headers: Record<string, string> = {}, socketIp?: string) {
  const raw: Request = new Request('http://localhost', { headers });
  return {
    req: {
      raw,
      header(name: string) {
        return raw.headers.get(name) ?? undefined;
      },
    },
    env: socketIp ? { requestIP: () => ({ address: socketIp }) } : {},
  } as any;
}

describe('getClientIp', () => {
  test('returns socket IP when trustProxy is false', () => {
    const c = mockContext({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '10.0.0.1');
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  test('returns unknown when no socket IP is available', () => {
    const c = mockContext({ 'x-forwarded-for': '1.2.3.4' });
    expect(getClientIp(c)).toBe('unknown');
  });

  test('uses forwarded chain when standalone trustProxy is set', () => {
    const c = mockContext({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, '127.0.0.1');
    setStandaloneTrustProxy(c.req.raw, 1);
    expect(getClientIp(c)).toBe('1.2.3.4');
  });

  test('falls back to socket IP when forwarded chain is too short', () => {
    const c = mockContext({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1');
    setStandaloneTrustProxy(c.req.raw, 1);
    expect(getClientIp(c)).toBe('127.0.0.1');
  });

  test('uses x-real-ip when proxy trust is enabled and xff is absent', () => {
    const c = mockContext({ 'x-real-ip': '9.8.7.6' }, '127.0.0.1');
    setStandaloneTrustProxy(c.req.raw, 1);
    expect(getClientIp(c)).toBe('9.8.7.6');
  });

  test('supports more than one trusted hop', () => {
    const c = mockContext({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' });
    setStandaloneTrustProxy(c.req.raw, 2);
    expect(getClientIp(c)).toBe('1.1.1.1');
  });

  test('normalizes IPv4-mapped IPv6 addresses', () => {
    const c = mockContext({}, '::ffff:127.0.0.1');
    expect(getClientIp(c)).toBe('127.0.0.1');
  });

  test('normalizes IPv4-mapped XFF entries', () => {
    const c = mockContext({ 'x-forwarded-for': '::ffff:1.2.3.4, 10.0.0.1' });
    setStandaloneTrustProxy(c.req.raw, 1);
    expect(getClientIp(c)).toBe('1.2.3.4');
  });

  test('ignores spoofed XFF when trustProxy is false', () => {
    const c = mockContext({ 'x-forwarded-for': 'spoofed-ip' }, 'real-socket-ip');
    expect(getClientIp(c)).toBe('real-socket-ip');
  });
});
