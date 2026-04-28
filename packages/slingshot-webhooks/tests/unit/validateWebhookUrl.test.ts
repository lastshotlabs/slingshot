import { describe, expect, it } from 'bun:test';
import { validateWebhookIp, validateWebhookUrl } from '../../src/lib/validateWebhookUrl';

describe('validateWebhookUrl', () => {
  // ── Valid URLs ────────────────────────────────────────────────────────────────

  it('accepts a valid HTTPS URL', () => {
    expect(() => validateWebhookUrl('https://example.com/hook')).not.toThrow();
  });

  it('accepts a valid HTTP URL', () => {
    expect(() => validateWebhookUrl('http://example.com/hook')).not.toThrow();
  });

  it('accepts an HTTPS URL with a path and query string', () => {
    expect(() => validateWebhookUrl('https://api.example.com/webhooks?token=abc123')).not.toThrow();
  });

  it('accepts an HTTPS URL with a port', () => {
    expect(() => validateWebhookUrl('https://example.com:8443/hook')).not.toThrow();
  });

  // ── Non-HTTP(S) schemes ───────────────────────────────────────────────────────

  it('rejects a ftp:// URL', () => {
    expect(() => validateWebhookUrl('ftp://example.com/hook')).toThrow(/scheme.*ftp.*not allowed/i);
  });

  it('rejects a file:// URL', () => {
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow(/scheme.*file.*not allowed/i);
  });

  it('rejects a javascript: URL', () => {
    expect(() => validateWebhookUrl('javascript:alert(1)')).toThrow();
  });

  // ── Loopback ──────────────────────────────────────────────────────────────────

  it('rejects http://localhost', () => {
    expect(() => validateWebhookUrl('http://localhost/admin')).toThrow(/localhost.*not allowed/i);
  });

  it('rejects http://localhost with a port', () => {
    expect(() => validateWebhookUrl('http://localhost:8080/admin')).toThrow(
      /localhost.*not allowed/i,
    );
  });

  it('rejects 127.0.0.1', () => {
    expect(() => validateWebhookUrl('http://127.0.0.1/admin')).toThrow(/loopback/i);
  });

  it('rejects 127.1.2.3 (loopback range)', () => {
    expect(() => validateWebhookUrl('http://127.1.2.3/hook')).toThrow(/loopback/i);
  });

  // ── Link-local (AWS metadata, etc.) ──────────────────────────────────────────

  it('rejects 169.254.169.254 (AWS instance metadata)', () => {
    expect(() => validateWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /link-local/i,
    );
  });

  it('rejects any 169.254.x.x address', () => {
    expect(() => validateWebhookUrl('http://169.254.1.1/hook')).toThrow(/link-local/i);
  });

  // ── Private IPv4 ranges ───────────────────────────────────────────────────────

  it('rejects 10.0.0.1 (RFC 1918 Class A)', () => {
    expect(() => validateWebhookUrl('http://10.0.0.1/hook')).toThrow(/private range/i);
  });

  it('rejects 10.255.255.255', () => {
    expect(() => validateWebhookUrl('http://10.255.255.255/hook')).toThrow(/private range/i);
  });

  it('rejects 172.16.0.1 (RFC 1918 Class B lower bound)', () => {
    expect(() => validateWebhookUrl('http://172.16.0.1/hook')).toThrow(/private range/i);
  });

  it('rejects 172.31.255.255 (RFC 1918 Class B upper bound)', () => {
    expect(() => validateWebhookUrl('http://172.31.255.255/hook')).toThrow(/private range/i);
  });

  it('does not reject 172.15.0.1 (just outside private range)', () => {
    expect(() => validateWebhookUrl('http://172.15.0.1/hook')).not.toThrow();
  });

  it('does not reject 172.32.0.1 (just outside private range)', () => {
    expect(() => validateWebhookUrl('http://172.32.0.1/hook')).not.toThrow();
  });

  it('rejects 192.168.1.1 (RFC 1918 Class C)', () => {
    expect(() => validateWebhookUrl('http://192.168.1.1/hook')).toThrow(/private range/i);
  });

  // ── Unspecified address ───────────────────────────────────────────────────────

  it('rejects 0.0.0.0', () => {
    expect(() => validateWebhookUrl('http://0.0.0.0/hook')).toThrow(/not routable/i);
  });

  // ── IPv6 ──────────────────────────────────────────────────────────────────────

  it('rejects [::1] (IPv6 loopback)', () => {
    expect(() => validateWebhookUrl('http://[::1]/hook')).toThrow(/loopback|unspecified/i);
  });

  it('rejects [::] (IPv6 unspecified address)', () => {
    expect(() => validateWebhookUrl('http://[::]/hook')).toThrow(/loopback|unspecified/i);
  });

  it('rejects [fe80::1] (IPv6 link-local)', () => {
    expect(() => validateWebhookUrl('http://[fe80::1]/hook')).toThrow(/link-local/i);
  });

  it('rejects [fe81::abcd] (IPv6 link-local fe80::/10 upper hextet)', () => {
    expect(() => validateWebhookUrl('http://[fe81::abcd]/hook')).toThrow(/link-local/i);
  });

  it('rejects [fe80::1%eth0] (link-local with zone identifier)', () => {
    // URL parsers vary on %-encoded zone IDs. Only run the assertion when the
    // hostname survives parsing; otherwise the test still proves the IP-level
    // validator rejects the bare zone form.
    let parsed = true;
    try {
      new URL('http://[fe80::1%25eth0]/hook');
    } catch {
      parsed = false;
    }
    if (parsed) {
      expect(() => validateWebhookUrl('http://[fe80::1%25eth0]/hook')).toThrow(/link-local/i);
    }
    expect(() => validateWebhookIp('fe80::1%eth0')).toThrow(/link-local/i);
  });

  it('rejects ::ffff:127.0.0.1 (IPv4-mapped loopback unwrapped to v4)', () => {
    // The IPv4-mapped form must be unwrapped and re-checked through the v4
    // validator. We exercise validateWebhookIp directly because some URL
    // parsers reject this as a hostname.
    expect(() => validateWebhookIp('::ffff:127.0.0.1')).toThrow(/loopback/i);
  });

  it('rejects [fc00::1] (IPv6 unique-local fc00::/7)', () => {
    expect(() => validateWebhookUrl('http://[fc00::1]/hook')).toThrow(/unique-local/i);
  });

  it('rejects [fd12:3456:789a::1] (IPv6 unique-local upper half of fc00::/7)', () => {
    expect(() => validateWebhookUrl('http://[fd12:3456:789a::1]/hook')).toThrow(/unique-local/i);
  });

  it('rejects [ff02::1] (IPv6 multicast ff00::/8)', () => {
    expect(() => validateWebhookUrl('http://[ff02::1]/hook')).toThrow(/multicast/i);
  });

  it('rejects [fec0::1] (deprecated IPv6 site-local fec0::/10)', () => {
    expect(() => validateWebhookUrl('http://[fec0::1]/hook')).toThrow(/site-local/i);
  });

  it('accepts [2001:db8::1] (IPv6 documentation range — not on the blocklist)', () => {
    // 2001:db8::/32 is reserved for documentation/examples but is treated as a
    // routable destination by the validator, so it should pass. The point of
    // this test is to confirm the IPv6 path is not over-broad.
    expect(() => validateWebhookUrl('http://[2001:db8::1]/hook')).not.toThrow();
  });

  // ── Invalid URLs ──────────────────────────────────────────────────────────────

  it('rejects a plain string that is not a URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow(/could not be parsed/i);
  });

  it('rejects an empty string', () => {
    expect(() => validateWebhookUrl('')).toThrow();
  });
});
