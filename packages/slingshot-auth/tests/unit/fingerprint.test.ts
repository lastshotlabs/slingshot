import { describe, expect, test } from 'bun:test';
import { buildFingerprint } from '../../src/lib/fingerprint';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost', { headers });
}

describe('buildFingerprint', () => {
  test('returns a 12-character hex string', async () => {
    const req = makeRequest({ 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' });
    const fp = await buildFingerprint(req);
    expect(fp).toHaveLength(12);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('same headers produce same fingerprint (deterministic)', async () => {
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html',
      'Accept-Language': 'en-US',
      'Accept-Encoding': 'gzip, deflate',
      Connection: 'keep-alive',
    };
    const fp1 = await buildFingerprint(makeRequest(headers));
    const fp2 = await buildFingerprint(makeRequest(headers));
    expect(fp1).toBe(fp2);
  });

  test('different User-Agent produces different fingerprint', async () => {
    const base = { Accept: 'text/html', 'Accept-Language': 'en-US' };
    const fp1 = await buildFingerprint(makeRequest({ ...base, 'User-Agent': 'Mozilla/5.0' }));
    const fp2 = await buildFingerprint(makeRequest({ ...base, 'User-Agent': 'curl/7.81.0' }));
    expect(fp1).not.toBe(fp2);
  });

  test('different Accept-Language produces different fingerprint', async () => {
    const base = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' };
    const fp1 = await buildFingerprint(makeRequest({ ...base, 'Accept-Language': 'en-US' }));
    const fp2 = await buildFingerprint(makeRequest({ ...base, 'Accept-Language': 'fr-FR' }));
    expect(fp1).not.toBe(fp2);
  });

  test('missing headers handled gracefully (empty string fallback)', async () => {
    const req = makeRequest({});
    const fp = await buildFingerprint(req);
    expect(fp).toHaveLength(12);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('browser headers bitmask: presence of sec-fetch-* headers affects output', async () => {
    const base = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' };
    const fpWithout = await buildFingerprint(makeRequest(base));
    const fpWith = await buildFingerprint(
      makeRequest({
        ...base,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
    );
    expect(fpWithout).not.toBe(fpWith);
  });

  test('two requests with identical headers produce identical fingerprint', async () => {
    const headers = {
      'User-Agent': 'TestBot/1.0',
      Accept: '*/*',
      'Accept-Language': 'en',
      'Accept-Encoding': 'br',
      Connection: 'close',
      'sec-ch-ua': '"Chromium";v="120"',
      origin: 'http://example.com',
    };
    const fp1 = await buildFingerprint(makeRequest(headers));
    const fp2 = await buildFingerprint(makeRequest(headers));
    expect(fp1).toBe(fp2);
  });

  test('different Accept-Encoding produces different fingerprint', async () => {
    const base = { 'User-Agent': 'Mozilla/5.0' };
    const fp1 = await buildFingerprint(makeRequest({ ...base, 'Accept-Encoding': 'gzip' }));
    const fp2 = await buildFingerprint(makeRequest({ ...base, 'Accept-Encoding': 'br' }));
    expect(fp1).not.toBe(fp2);
  });

  test('full browser-like request produces valid fingerprint', async () => {
    const req = makeRequest({
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-ch-ua': '"Chromium";v="120", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      origin: 'http://localhost',
      referer: 'http://localhost/',
      'x-requested-with': 'XMLHttpRequest',
    });
    const fp = await buildFingerprint(req);
    expect(fp).toHaveLength(12);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });
});
