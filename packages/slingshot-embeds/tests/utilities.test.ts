import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parseOgMetadata, unfurl, validateUrl } from '../src';
import { createEmbedCache } from '../src/lib/cache';

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let dnsSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  dnsSpy?.mockRestore();
  fetchSpy = null;
  dnsSpy = null;
});

describe('embed HTML parsing', () => {
  test('parses OG, twitter, favicon, and relative asset URLs from head metadata', () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Tom &amp; Jerry" />
          <meta content="A &quot;classic&quot;" property="og:description" />
          <meta name="twitter:image" content="/images/card.png" />
          <meta property="og:site_name" content="Cartoons" />
          <meta property="og:type" content="video.movie" />
          <link rel="shortcut icon" href="/favicon.ico" />
          <title>Ignored fallback title</title>
        </head>
        <body><meta property="og:title" content="ignored-body" /></body>
      </html>
    `;

    expect(parseOgMetadata(html, 'https://example.com/posts/123')).toEqual({
      title: 'Tom & Jerry',
      description: 'A "classic"',
      image: 'https://example.com/images/card.png',
      siteName: 'Cartoons',
      type: 'video.movie',
      favicon: 'https://example.com/favicon.ico',
    });
  });

  test('falls back to title and meta description when OG tags are absent', () => {
    const html = `
      <html>
        <head>
          <meta name="description" content="Fallback description" />
          <title>Fallback title</title>
        </head>
      </html>
    `;

    expect(parseOgMetadata(html)).toEqual({
      title: 'Fallback title',
      description: 'Fallback description',
    });
  });
});

describe('embed SSRF validation', () => {
  test('accepts allowed public URLs and rejects blocked/private targets', () => {
    const allowed = validateUrl('https://sub.example.com/article', {
      allowedDomains: ['example.com'],
    });
    const blockedByList = validateUrl('https://api.bad.example/path', {
      blockedDomains: ['bad.example'],
    });
    const blockedLocalhost = validateUrl('http://localhost/admin', {});
    const blockedPrivateIp = validateUrl('http://192.168.1.10/internal', {});
    const blockedProtocol = validateUrl('file:///etc/passwd', {});

    expect(allowed.valid).toBe(true);
    expect(blockedByList).toEqual({
      valid: false,
      reason: 'Domain is blocked: api.bad.example',
    });
    expect(blockedLocalhost).toEqual({
      valid: false,
      reason: 'Private/reserved hostname',
    });
    expect(blockedPrivateIp).toEqual({
      valid: false,
      reason: 'Private/reserved IP address',
    });
    expect(blockedProtocol).toEqual({
      valid: false,
      reason: 'Disallowed protocol: file:',
    });
  });
});

describe('embed cache', () => {
  test('evicts the oldest entry at capacity and expires stale entries', async () => {
    const cache = createEmbedCache({ ttlMs: 10, maxEntries: 2 });

    cache.set('a', { title: 'A', url: 'https://example.com/a' });
    cache.set('b', { title: 'B', url: 'https://example.com/b' });
    cache.set('c', { title: 'C', url: 'https://example.com/c' });

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toMatchObject({ title: 'B' });
    expect(cache.get('c')).toMatchObject({ title: 'C' });

    await Bun.sleep(15);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('embed unfurl redirects', () => {
  test('resolves final url metadata against the final redirect target', async () => {
    dnsSpy = spyOn(Bun.dns, 'lookup').mockImplementation(async () => [
      { address: '93.184.216.34' },
    ]);
    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/final' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `
            <html>
              <head>
                <meta property="og:title" content="Redirected" />
                <meta property="og:image" content="/images/card.png" />
              </head>
            </html>
          `,
          {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        ),
      );

    const result = await unfurl('https://example.com/start', {
      timeoutMs: 1_000,
      maxResponseBytes: 32_768,
    });

    expect(result.url).toBe('https://cdn.example.com/final');
    expect(result.title).toBe('Redirected');
    expect(result.image).toBe('https://cdn.example.com/images/card.png');
  });
});
