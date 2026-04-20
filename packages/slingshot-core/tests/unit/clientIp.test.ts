import { describe, expect, test } from 'bun:test';
import {
  getClientIp,
  getClientIpFromRequest,
  setStandaloneClientIp,
  setStandaloneTrustProxy,
} from '../../src/clientIp';

describe('setStandaloneTrustProxy', () => {
  test('attaches trust proxy value to request', () => {
    const req = new Request('http://localhost');
    setStandaloneTrustProxy(req, 2);
    // getClientIpFromRequest reads this internally
    const ip = getClientIpFromRequest(req, 2);
    expect(typeof ip).toBe('string');
  });
});

describe('setStandaloneClientIp', () => {
  test('attaches client IP to request', () => {
    const req = new Request('http://localhost');
    setStandaloneClientIp(req, '192.168.1.1');
    const ip = getClientIpFromRequest(req, false);
    expect(ip).toBe('192.168.1.1');
  });
});

describe('getClientIpFromRequest', () => {
  test('returns socket IP when trustProxy is false', () => {
    const req = new Request('http://localhost');
    setStandaloneClientIp(req, '10.0.0.1');
    expect(getClientIpFromRequest(req, false)).toBe('10.0.0.1');
  });

  test('returns unknown when no socket IP and trustProxy is false', () => {
    const req = new Request('http://localhost');
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });

  test('reads X-Forwarded-For when trustProxy is set', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Forwarded-For': '1.2.3.4, 5.6.7.8, 9.10.11.12' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    // trustProxy=1 reads 1 from right (idx = 3 - 1 - 1 = 1) -> 5.6.7.8
    expect(getClientIpFromRequest(req, 1)).toBe('5.6.7.8');
  });

  test('returns socket IP when XFF index is out of range', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    // trustProxy=5 would need idx = 1 - 5 - 1 = -5 (out of range)
    expect(getClientIpFromRequest(req, 5)).toBe('127.0.0.1');
  });

  test('falls back to X-Real-IP when no XFF', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Real-IP': '44.55.66.77' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    expect(getClientIpFromRequest(req, 1)).toBe('44.55.66.77');
  });

  test('normalizes ::ffff: prefix from socket IP', () => {
    const req = new Request('http://localhost');
    setStandaloneClientIp(req, '::ffff:192.168.1.1');
    expect(getClientIpFromRequest(req, false)).toBe('192.168.1.1');
  });

  test('normalizes ::ffff: prefix from XFF', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Forwarded-For': '::ffff:10.0.0.1' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    expect(getClientIpFromRequest(req, 0)).toBe('10.0.0.1');
  });

  test('normalizes ::ffff: prefix from X-Real-IP', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Real-IP': '::ffff:10.0.0.5' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    expect(getClientIpFromRequest(req, 1)).toBe('10.0.0.5');
  });

  test('falls back to socket IP when no XFF or X-Real-IP and trustProxy set', () => {
    const req = new Request('http://localhost');
    setStandaloneClientIp(req, '99.99.99.99');
    expect(getClientIpFromRequest(req, 1)).toBe('99.99.99.99');
  });
});

describe('getClientIp', () => {
  test('returns client IP from Hono-like context', () => {
    const req = new Request('http://localhost');
    setStandaloneClientIp(req, '10.0.0.1');
    const c = {
      req: { raw: req, header: (name: string) => req.headers.get(name) ?? undefined },
      get: () => undefined,
      env: {},
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('10.0.0.1');
  });

  test('reads trustProxy from slingshotCtx', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Forwarded-For': '1.2.3.4, 5.6.7.8' },
    });
    setStandaloneClientIp(req, '127.0.0.1');
    const c = {
      req: { raw: req, header: (name: string) => req.headers.get(name) ?? undefined },
      get: (key: string) => {
        if (key === 'slingshotCtx') return { trustProxy: 1 };
        return undefined;
      },
      env: {},
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('1.2.3.4');
  });

  test('uses requestIP from env when available', () => {
    const req = new Request('http://localhost');
    const c = {
      req: { raw: req, header: () => undefined },
      get: () => undefined,
      env: { requestIP: () => ({ address: '33.44.55.66' }) },
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('33.44.55.66');
  });

  test('handles requestIP returning null', () => {
    const req = new Request('http://localhost');
    const c = {
      req: { raw: req, header: () => undefined },
      get: () => undefined,
      env: { requestIP: () => null },
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('unknown');
  });

  test('handles requestIP throwing', () => {
    const req = new Request('http://localhost');
    const c = {
      req: { raw: req, header: () => undefined },
      get: () => undefined,
      env: {
        requestIP: () => {
          throw new Error('not available');
        },
      },
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('unknown');
  });

  test('attaches header reader fallback when headers.get is not available', () => {
    const req = new Request('http://localhost', {
      headers: { 'X-Real-IP': '55.66.77.88' },
    });
    setStandaloneTrustProxy(req, 1);
    // Create a raw-like object without headers.get
    const rawReq = Object.create(req, {
      headers: { value: null, writable: true },
    });
    const c = {
      req: {
        raw: rawReq,
        header: (name: string) => req.headers.get(name) ?? undefined,
      },
      get: () => undefined,
      env: {},
    };
    const ip = getClientIp(c as never);
    expect(ip).toBe('55.66.77.88');
  });
});
