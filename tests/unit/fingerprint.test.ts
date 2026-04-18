import { buildFingerprint } from '@auth/lib/fingerprint';
import { describe, expect, test } from 'bun:test';

describe('buildFingerprint', () => {
  test('returns a 12-char hex string', async () => {
    const req = new Request('http://localhost', {
      headers: {
        'user-agent': 'Mozilla/5.0 Test Browser',
        accept: 'text/html',
        'accept-language': 'en-US',
      },
    });
    const fp = await buildFingerprint(req);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('same headers produce same fingerprint', async () => {
    const headers = { 'user-agent': 'TestBot/1.0', accept: '*/*' };
    const fp1 = await buildFingerprint(new Request('http://localhost', { headers }));
    const fp2 = await buildFingerprint(new Request('http://localhost', { headers }));
    expect(fp1).toBe(fp2);
  });

  test('different User-Agent produces different fingerprint', async () => {
    const fp1 = await buildFingerprint(
      new Request('http://localhost', { headers: { 'user-agent': 'BrowserA' } }),
    );
    const fp2 = await buildFingerprint(
      new Request('http://localhost', { headers: { 'user-agent': 'BrowserB' } }),
    );
    expect(fp1).not.toBe(fp2);
  });

  test('missing headers produce a valid fingerprint', async () => {
    const fp = await buildFingerprint(new Request('http://localhost'));
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });
});
