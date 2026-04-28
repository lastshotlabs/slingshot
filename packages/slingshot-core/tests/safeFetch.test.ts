import { type Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  SafeFetchBlockedError,
  SafeFetchDnsError,
  createSafeFetch,
  isPrivateOrLoopbackIp,
} from '../src/http/safeFetch';

describe('isPrivateOrLoopbackIp', () => {
  test('IPv4 private ranges are blocked', () => {
    expect(isPrivateOrLoopbackIp('10.0.0.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('192.168.1.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('172.20.0.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('172.16.0.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('172.31.0.1', 4)).toBe(true);
  });

  test('IPv4 loopback / link-local / wildcard / multicast blocked', () => {
    expect(isPrivateOrLoopbackIp('127.0.0.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('169.254.1.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('0.0.0.0', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('224.0.0.1', 4)).toBe(true);
    expect(isPrivateOrLoopbackIp('255.255.255.255', 4)).toBe(true);
  });

  test('IPv4 public addresses are allowed', () => {
    expect(isPrivateOrLoopbackIp('8.8.8.8', 4)).toBe(false);
    expect(isPrivateOrLoopbackIp('1.1.1.1', 4)).toBe(false);
    expect(isPrivateOrLoopbackIp('172.15.0.1', 4)).toBe(false); // just below private
    expect(isPrivateOrLoopbackIp('172.32.0.1', 4)).toBe(false); // just above private
  });

  test('IPv6 link-local, unique-local, loopback, multicast blocked', () => {
    expect(isPrivateOrLoopbackIp('fe80::1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('fc00::1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('fd12:3456:789a::1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('::1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('::', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('ff00::1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('ff02::1', 6)).toBe(true);
  });

  test('IPv6 mapped IPv4 inherits IPv4 policy', () => {
    expect(isPrivateOrLoopbackIp('::ffff:127.0.0.1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('::ffff:10.0.0.1', 6)).toBe(true);
    expect(isPrivateOrLoopbackIp('::ffff:8.8.8.8', 6)).toBe(false);
  });

  test('IPv6 zone-id is stripped before classification', () => {
    expect(isPrivateOrLoopbackIp('fe80::1%eth0', 6)).toBe(true);
  });

  test('IPv6 public addresses are allowed', () => {
    expect(isPrivateOrLoopbackIp('2001:4860:4860::8888', 6)).toBe(false);
    expect(isPrivateOrLoopbackIp('2606:4700:4700::1111', 6)).toBe(false);
  });
});

describe('createSafeFetch IP policy', () => {
  test('IP literal in URL skips DNS resolution', async () => {
    const resolveHost = mock(async () => [{ address: '8.8.8.8', family: 4 as const }]);
    const isIpAllowed = mock(() => false); // always block to short-circuit before fetch
    const safeFetch = createSafeFetch({ resolveHost, isIpAllowed });

    await expect(safeFetch('http://1.2.3.4/path')).rejects.toBeInstanceOf(SafeFetchBlockedError);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(isIpAllowed).toHaveBeenCalledWith('1.2.3.4', 4);
  });

  test('hostname is resolved once and IP validated', async () => {
    const resolveHost = mock(async () => [{ address: '203.0.113.5', family: 4 as const }]);
    const isIpAllowed = mock(() => false);
    const safeFetch = createSafeFetch({ resolveHost, isIpAllowed });

    await expect(safeFetch('http://example.invalid/foo')).rejects.toBeInstanceOf(
      SafeFetchBlockedError,
    );
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith('example.invalid');
    expect(isIpAllowed).toHaveBeenCalledWith('203.0.113.5', 4);
  });

  test('blocked IP throws SafeFetchBlockedError with the resolved IP', async () => {
    const safeFetch = createSafeFetch({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    try {
      await safeFetch('http://attacker.invalid/');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SafeFetchBlockedError);
      expect((err as SafeFetchBlockedError).ip).toBe('127.0.0.1');
      expect((err as SafeFetchBlockedError).reason).toBe('ip-blocked');
    }
  });

  test('DNS failure throws SafeFetchDnsError', async () => {
    const safeFetch = createSafeFetch({
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    try {
      await safeFetch('http://nope.invalid/');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SafeFetchDnsError);
      expect((err as SafeFetchDnsError).hostname).toBe('nope.invalid');
    }
  });

  test('empty DNS records throw SafeFetchDnsError', async () => {
    const safeFetch = createSafeFetch({
      resolveHost: async () => [],
    });
    await expect(safeFetch('http://nope.invalid/')).rejects.toBeInstanceOf(SafeFetchDnsError);
  });

  test('IPv6 link-local hostname result is blocked', async () => {
    const safeFetch = createSafeFetch({
      resolveHost: async () => [{ address: 'fe80::1', family: 6 }],
    });
    await expect(safeFetch('http://host.invalid/')).rejects.toBeInstanceOf(SafeFetchBlockedError);
  });
});

// Exercise the actual fetch path against a local server. We use a 127.0.0.1
// URL with the `isIpAllowed` policy overridden to allow loopback, so the test
// is robust across runtimes (Node honors the undici dispatcher; Bun ships a
// stub Agent and falls through to native fetch — both reach the local server).
describe('createSafeFetch live request', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('IP literal URL with allow-loopback policy reaches the server', async () => {
    const safeFetch = createSafeFetch({
      isIpAllowed: () => true, // explicit override (default would block 127.0.0.1)
    });
    const res = await safeFetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
