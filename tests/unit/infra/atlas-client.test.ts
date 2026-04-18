import { describe, expect, it, mock } from 'bun:test';
import {
  digestFetch,
  mapAwsRegionToAtlas,
} from '../../../packages/slingshot-infra/src/resource/atlasClient';

// ---------------------------------------------------------------------------
// mapAwsRegionToAtlas
// ---------------------------------------------------------------------------

describe('mapAwsRegionToAtlas', () => {
  it('converts us-east-1 to US_EAST_1', () => {
    expect(mapAwsRegionToAtlas('us-east-1')).toBe('US_EAST_1');
  });

  it('converts eu-west-1 to EU_WEST_1', () => {
    expect(mapAwsRegionToAtlas('eu-west-1')).toBe('EU_WEST_1');
  });

  it('converts ap-southeast-2 to AP_SOUTHEAST_2', () => {
    expect(mapAwsRegionToAtlas('ap-southeast-2')).toBe('AP_SOUTHEAST_2');
  });

  it('converts us-west-2 to US_WEST_2', () => {
    expect(mapAwsRegionToAtlas('us-west-2')).toBe('US_WEST_2');
  });
});

// ---------------------------------------------------------------------------
// digestFetch — digest auth challenge/response flow
// ---------------------------------------------------------------------------

describe('digestFetch', () => {
  it('returns non-401 response directly without performing digest', async () => {
    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const res = await digestFetch(
        'https://cloud.mongodb.com/api/atlas/v2.0/groups/proj/clusters',
        {
          method: 'GET',
          publicKey: 'pub',
          privateKey: 'priv',
        },
      );

      expect(res.status).toBe(200);
      // Only one request — no digest challenge needed
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('performs digest challenge/response on 401', async () => {
    let callCount = 0;
    const mockFetch = mock(async (_url: string, opts?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call — return 401 with WWW-Authenticate digest challenge
        return new Response('Unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Digest realm="MMS Public API", qop="auth", nonce="abc123nonce456", opaque="opaque789"',
          },
        });
      }
      // Second call — check Authorization header was set
      const authHeader = (opts?.headers as Record<string, string>)?.Authorization ?? '';
      expect(authHeader).toMatch(/^Digest /);
      expect(authHeader).toContain('username="pub"');
      expect(authHeader).toContain('realm="MMS Public API"');
      expect(authHeader).toContain('nonce="abc123nonce456"');
      expect(authHeader).toContain('response="');
      return new Response(JSON.stringify({ stateName: 'IDLE' }), { status: 200 });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const res = await digestFetch(
        'https://cloud.mongodb.com/api/atlas/v2.0/groups/proj/clusters',
        {
          method: 'GET',
          publicKey: 'pub',
          privateKey: 'priv',
        },
      );

      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends Content-Type header when body is provided', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = mock(async (_url: string, opts?: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await digestFetch('https://cloud.mongodb.com/api/atlas/v2.0/groups/proj/clusters', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
        publicKey: 'pub',
        privateKey: 'priv',
      });

      expect(capturedHeaders?.['Content-Type']).toBe('application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes Accept: application/vnd.atlas.2023-01-01+json header', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = mock(async (_url: string, opts?: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await digestFetch('https://cloud.mongodb.com/api/atlas/v2.0/groups/proj/clusters', {
        method: 'GET',
        publicKey: 'pub',
        privateKey: 'priv',
      });

      expect(capturedHeaders?.Accept).toBe('application/vnd.atlas.2023-01-01+json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
