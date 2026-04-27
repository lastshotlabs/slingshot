import { describe, expect, it } from 'bun:test';
import { validateWebhookUrl } from '../../src/lib/validateWebhookUrl';

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

  // ── Invalid URLs ──────────────────────────────────────────────────────────────

  it('rejects a plain string that is not a URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow(/could not be parsed/i);
  });

  it('rejects an empty string', () => {
    expect(() => validateWebhookUrl('')).toThrow();
  });
});
