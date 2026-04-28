import { describe, expect, it, mock } from 'bun:test';
import { fetchSourceImage } from '../../src/image/serve';
import { ImageSourceBlockedError, ImageSourceDnsError } from '../../src/image/types';

function asFetch(m: ReturnType<typeof mock>): typeof fetch {
  return m as unknown as typeof fetch;
}

describe('fetchSourceImage safeFetch (DNS pinning)', () => {
  it('blocks fetch when the URL is a literal private IPv4 address', async () => {
    // safeFetch detects IP-literal hostnames and validates them directly,
    // without going through resolveHost. No fetchImpl override here so the
    // real safeFetch path runs.
    try {
      await fetchSourceImage('http://10.0.0.1/foo.jpg', undefined, 1024 * 1024, 1000);
      expect.unreachable('expected ImageSourceBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageSourceBlockedError);
      expect((err as ImageSourceBlockedError).ip).toBe('10.0.0.1');
    }
  });

  it('blocks fetch when DNS resolves to a private IPv4 address', async () => {
    try {
      await fetchSourceImage('http://internal.example/foo.jpg', undefined, 1024 * 1024, 1000, {
        resolveHost: async () => [{ address: '10.0.0.1', family: 4 }],
      });
      expect.unreachable('expected ImageSourceBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageSourceBlockedError);
      expect((err as ImageSourceBlockedError).ip).toBe('10.0.0.1');
    }
  });

  it('succeeds when DNS resolves to a public IPv4 address', async () => {
    const buffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // tiny JPEG header
    const headers = new Headers({ 'Content-Type': 'image/jpeg' });
    const response = new Response(buffer, { status: 200, headers });

    const result = await fetchSourceImage(
      'http://example.com/foo.jpg',
      undefined,
      1024 * 1024,
      1000,
      {
        resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: (async () => response) as unknown as typeof fetch,
      },
    );

    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer.byteLength).toBe(4);
  });

  it('wraps DNS resolution failure as ImageSourceDnsError', async () => {
    try {
      await fetchSourceImage('http://nodns.example/foo.jpg', undefined, 1024 * 1024, 1000, {
        resolveHost: async () => {
          throw new Error('ENOTFOUND nodns.example');
        },
      });
      expect.unreachable('expected ImageSourceDnsError');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageSourceDnsError);
      expect((err as ImageSourceDnsError).hostname).toBe('nodns.example');
    }
  });

  it('blocks IPv6 link-local resolution', async () => {
    try {
      await fetchSourceImage('http://v6.example/foo.jpg', undefined, 1024 * 1024, 1000, {
        resolveHost: async () => [{ address: 'fe80::1', family: 6 }],
      });
      expect.unreachable('expected ImageSourceBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageSourceBlockedError);
      expect((err as ImageSourceBlockedError).ip).toBe('fe80::1');
    }
  });

  it('uses plain fetch for relative URLs (local server intentional)', async () => {
    // Relative URLs are a local-service call, not user-controlled remote.
    // safeFetch's loopback default would block this, so fetchSourceImage
    // bypasses safeFetch for relative URLs.
    const fetchMock = mock(async () => {
      const buf = new Uint8Array([1, 2, 3]);
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(fetchMock);
    try {
      const result = await fetchSourceImage('/local-asset.png', 'localhost:3000', 1024, 1000);
      expect(result.contentType).toBe('image/png');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toBe('http://localhost:3000/local-asset.png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
