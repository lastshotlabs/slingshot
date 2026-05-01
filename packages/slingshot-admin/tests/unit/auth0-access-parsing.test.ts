/**
 * Tests for Auth0 access provider token parsing and error handling.
 *
 * Complements `auth0Provider.test.ts`, which covers valid-token flows, generic
 * error paths, claim-shape validation, timeout, and option pinning.  This file
 * focuses on token-parsing edge cases (empty / malformed tokens) and specific
 * jwtVerify rejection scenarios (network errors, invalid signatures, expired
 * tokens, wrong audience / issuer).
 */
import { describe, expect, mock, test } from 'bun:test';
import type { Auth0Deps } from '../../src/providers/auth0Access';
import { createAuth0AccessProvider } from '../../src/providers/auth0Access';

// ---------------------------------------------------------------------------
// Helpers (mirror patterns from auth0Provider.test.ts)
// ---------------------------------------------------------------------------

const DOMAIN = 'test.auth0.com';
const AUDIENCE = 'https://api.example.com';

function makeStubDeps(overrides?: Partial<Auth0Deps>): Auth0Deps {
  return {
    createRemoteJWKSet: mock(() => {
      return (() => Promise.resolve({})) as never;
    }) as Auth0Deps['createRemoteJWKSet'],
    jwtVerify: mock(async () => {
      return {
        payload: { sub: 'auth0|user-1', aud: AUDIENCE, iss: `https://${DOMAIN}/` },
        protectedHeader: { alg: 'RS256' },
      } as never;
    }) as Auth0Deps['jwtVerify'],
    ...overrides,
  };
}

function makeContext(token?: string): never {
  return {
    req: {
      header: (name: string) =>
        name === 'authorization' ? (token != null ? `Bearer ${token}` : undefined) : undefined,
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth0Access token parsing', () => {
  test('returns null when Bearer token value is an empty string', async () => {
    // Override jwtVerify to reject on empty token, matching real jose behavior.
    const deps = makeStubDeps({
      jwtVerify: mock((token: string) => {
        if (!token) return Promise.reject(new Error('malformed token'));
        return Promise.resolve({
          payload: { sub: 'auth0|user-1', aud: AUDIENCE, iss: `https://${DOMAIN}/` },
          protectedHeader: { alg: 'RS256' },
        } as never);
      }) as Auth0Deps['jwtVerify'],
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext(''));
    expect(principal).toBeNull();
  });

  test('returns null when Bearer token value is only whitespace', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock((token: string) => {
        if (!token.trim()) return Promise.reject(new Error('malformed token'));
        return Promise.resolve({
          payload: { sub: 'auth0|user-1', aud: AUDIENCE, iss: `https://${DOMAIN}/` },
          protectedHeader: { alg: 'RS256' },
        } as never);
      }) as Auth0Deps['jwtVerify'],
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('   '));
    expect(principal).toBeNull();
  });

  test('handles authorization header with extra leading whitespace', async () => {
    // The header check uses startsWith('Bearer '); extra whitespace before
    // "Bearer" should not match and should return null.
    const ctx = {
      req: {
        header: () => '  Bearer token',
      },
    } as never;
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(ctx);
    expect(principal).toBeNull();
  });
});

describe('auth0Access error handling paths', () => {
  test('returns null when JWKS fetch fails with network error', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('fetch failed'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('valid.encoded.jwt'));
    expect(principal).toBeNull();
  });

  test('returns null when signature verification fails', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('signature verification failed'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('tampered.token.sig'));
    expect(principal).toBeNull();
  });

  test('returns null when JWT is malformed and cannot be parsed', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new SyntaxError('malformed token'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('not-a-valid.jwt'));
    expect(principal).toBeNull();
  });

  test('returns null when JWKS key cannot be found for the given kid', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('unable to find a key'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('token.unknown.kid'));
    expect(principal).toBeNull();
  });
});

describe('auth0Access edge cases', () => {
  test('returns null when token is expired', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('"exp" claim check failed'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('expired.token.here'));
    expect(principal).toBeNull();
  });

  test('returns null when token audience does not match configured audience', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('audience mismatch'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('wrong-aud.token'));
    expect(principal).toBeNull();
  });

  test('returns null when token issuer does not match configured issuer', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('issuer mismatch'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('wrong-iss.token'));
    expect(principal).toBeNull();
  });

  test('returns null when token uses algorithm other than RS256', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('algorithm not allowed'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('hs256-signed.token'));
    expect(principal).toBeNull();
  });

  test('returns null for token with future nbf (not before) claim', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('"nbf" claim check failed'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('future-nbf.token'));
    expect(principal).toBeNull();
  });
});
