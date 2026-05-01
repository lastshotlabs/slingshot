import { describe, expect, it } from 'bun:test';
import { validateWebhookIp, validateWebhookUrl } from '../../src/lib/validateWebhookUrl';

describe('validateWebhookUrl', () => {
  // ── Valid URLs ────────────────────────────────────────────────────────────────

  it('accepts standard https URLs', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/callback')).not.toThrow();
  });

  it('accepts http URLs on non-standard ports', () => {
    expect(() => validateWebhookUrl('http://api.example.com:9000/hook')).not.toThrow();
  });

  // ── Invalid URLs ─────────────────────────────────────────────────────────────

  it('rejects a string that is not parseable as a URL', () => {
    expect(() => validateWebhookUrl('')).toThrow();
    expect(() => validateWebhookUrl('not-a-url')).toThrow(/could not be parsed/i);
    expect(() => validateWebhookUrl('   ')).toThrow();
  });

  // ── Protocol validation ───────────────────────────────────────────────────────

  it('rejects non-HTTP(S) schemes including ws and ssh', () => {
    expect(() => validateWebhookUrl('ws://example.com/hook')).toThrow(/scheme.*not allowed/i);
    expect(() => validateWebhookUrl('ssh://example.com/hook')).toThrow(/scheme.*not allowed/i);
    expect(() => validateWebhookUrl('ftp://example.com/hook')).toThrow(/scheme.*not allowed/i);
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow(/scheme.*not allowed/i);
  });

  // ── SSRF: loopback / localhost ───────────────────────────────────────────────

  it('rejects plain localhost hostname', () => {
    expect(() => validateWebhookUrl('http://localhost/hook')).toThrow(/localhost/i);
    expect(() => validateWebhookUrl('http://localhost:3000/hook')).toThrow(/localhost/i);
  });

  it('rejects subdomain.localhost', () => {
    expect(() => validateWebhookUrl('http://app.localhost/hook')).toThrow(/localhost/i);
    expect(() => validateWebhookUrl('http://api.internal.localhost/hook')).toThrow(/localhost/i);
  });

  it('rejects IPv4 loopback addresses', () => {
    expect(() => validateWebhookUrl('http://127.0.0.1/hook')).toThrow(/loopback/i);
    expect(() => validateWebhookUrl('http://127.255.255.255/hook')).toThrow(/loopback/i);
  });

  it('rejects IPv6 loopback and unspecified addresses', () => {
    expect(() => validateWebhookUrl('http://[::1]/hook')).toThrow(/loopback|unspecified/i);
    expect(() => validateWebhookUrl('http://[::]/hook')).toThrow(/loopback|unspecified/i);
  });

  // ── SSRF: private IPv4 ranges ─────────────────────────────────────────────────

  it('rejects RFC 1918 private ranges', () => {
    expect(() => validateWebhookUrl('http://10.1.2.3/hook')).toThrow(/private range/i);
    expect(() => validateWebhookUrl('http://172.16.1.1/hook')).toThrow(/private range/i);
    expect(() => validateWebhookUrl('http://172.31.255.255/hook')).toThrow(/private range/i);
    expect(() => validateWebhookUrl('http://192.168.0.1/hook')).toThrow(/private range/i);
  });

  // ── SSRF: link-local (metadata endpoints) ─────────────────────────────────────

  it('rejects 169.254.x.x link-local addresses', () => {
    expect(() => validateWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /link-local/i,
    );
    expect(() => validateWebhookUrl('http://169.254.1.1/hook')).toThrow(/link-local/i);
  });

  // ── SSRF: carrier-grade NAT ───────────────────────────────────────────────────

  it('rejects 100.64.0.0/10 carrier-grade NAT (RFC 6598)', () => {
    expect(() => validateWebhookUrl('http://100.64.0.1/hook')).toThrow(
      /carrier-grade nat|100\.64/i,
    );
    expect(() => validateWebhookUrl('http://100.127.255.255/hook')).toThrow(
      /carrier-grade nat|100\.64/i,
    );
  });

  it('allows addresses just outside carrier-grade NAT range', () => {
    expect(() => validateWebhookUrl('http://100.63.255.255/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://100.128.0.1/hook')).not.toThrow();
  });

  // ── SSRF: multicast and reserved IPv4 ─────────────────────────────────────────

  it('rejects IPv4 multicast range (224.0.0.0/4)', () => {
    expect(() => validateWebhookUrl('http://224.0.0.1/hook')).toThrow(/multicast/i);
    expect(() => validateWebhookUrl('http://239.255.255.255/hook')).toThrow(/multicast/i);
  });

  it('rejects IPv4 reserved range including broadcast (240.0.0.0/4)', () => {
    expect(() => validateWebhookUrl('http://240.0.0.1/hook')).toThrow(/reserved/i);
    expect(() => validateWebhookUrl('http://255.255.255.255/hook')).toThrow(/reserved/i);
  });
});

describe('validateWebhookIp', () => {
  it('passes through public IPv4 addresses', () => {
    expect(() => validateWebhookIp('8.8.8.8')).not.toThrow();
    expect(() => validateWebhookIp('1.1.1.1')).not.toThrow();
    expect(() => validateWebhookIp('203.0.113.42')).not.toThrow();
  });

  it('passes through public IPv6 addresses', () => {
    expect(() => validateWebhookIp('2001:db8::1')).not.toThrow();
    expect(() => validateWebhookIp('2606:4700:4700::1111')).not.toThrow();
  });

  it('passes through hostnames (non-IP strings)', () => {
    // validateWebhookIp only inspects literal IPs; hostnames pass through.
    expect(() => validateWebhookIp('example.com')).not.toThrow();
    expect(() => validateWebhookIp('my.internal.service')).not.toThrow();
  });

  it('unwraps and rejects IPv4-mapped IPv6 loopback', () => {
    expect(() => validateWebhookIp('::ffff:127.0.0.1')).toThrow(/loopback/i);
  });

  it('rejects zone-id suffixed link-local addresses', () => {
    expect(() => validateWebhookIp('fe80::1%eth0')).toThrow(/link-local/i);
  });

  it('rejects IPv6 site-local (deprecated fec0::/10)', () => {
    expect(() => validateWebhookIp('fec0::1')).toThrow(/site-local/i);
  });

  it('rejects 0.0.0.0', () => {
    expect(() => validateWebhookIp('0.0.0.0')).toThrow(/not routable/i);
  });
});
