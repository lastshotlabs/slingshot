import { describe, expect, mock, test } from 'bun:test';
import type { Auth0Deps } from '../../src/providers/auth0Access';
import { createAuth0AccessProvider } from '../../src/providers/auth0Access';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const DOMAIN = 'test.auth0.com';
const AUDIENCE = 'https://api.example.com';

function makeStubDeps(overrides?: Partial<Auth0Deps>): Auth0Deps {
  return {
    // cast needed: jose's JWKS function type has internal tracking properties
    // (coolingDown, fresh, jwks) that are irrelevant in test stubs
    createRemoteJWKSet: mock(() => {
      const empty = {};
      return (() => Promise.resolve(empty)) as never;
    }) as Auth0Deps['createRemoteJWKSet'],
    // cast needed: jose's JWTVerifyResult requires a `key` field (ResolvedKey) that
    // is not present in test payloads
    jwtVerify: mock(async () => {
      const emptyKey = {};
      const key = emptyKey as unknown as CryptoKey;
      return {
        payload: {
          sub: 'auth0|user-123',
          aud: AUDIENCE,
          iss: `https://${DOMAIN}/`,
          email: 'alice@example.com',
          name: 'Alice',
          extra_claim: 'value',
        },
        protectedHeader: { alg: 'RS256' },
        key,
      };
    }) as Auth0Deps['jwtVerify'],
    ...overrides,
  };
}

function makeContext(token?: string): never {
  const raw = {
    req: {
      header: (name: string) => {
        if (name === 'authorization') return token ? `Bearer ${token}` : undefined;
        return undefined;
      },
    },
  };
  return raw as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuth0AccessProvider', () => {
  test('verifies a valid JWT and returns principal', async () => {
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('valid.jwt.token'));

    expect(principal).not.toBeNull();
    expect(principal?.subject).toBe('auth0|user-123');
    expect(principal?.provider).toBe('auth0');
    expect(principal?.email).toBe('alice@example.com');
    expect(principal?.displayName).toBe('Alice');
  });

  test('includes rawClaims on the principal', async () => {
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('valid.jwt.token'));

    expect(principal?.rawClaims).toBeDefined();
    expect((principal?.rawClaims as Record<string, unknown>)['extra_claim']).toBe('value');
  });

  test('returns null when Authorization header is missing', async () => {
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext());
    expect(principal).toBeNull();
  });

  test('returns null when token is not Bearer-prefixed', async () => {
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const ctxRaw = {
      req: {
        header: (name: string) => (name === 'authorization' ? 'Basic credentials' : undefined),
      },
    };
    const principal = await provider.verifyRequest(ctxRaw as never);
    expect(principal).toBeNull();
  });

  test('returns null when jwtVerify throws', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(() => Promise.reject(new Error('Invalid token'))),
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('bad.token'));
    expect(principal).toBeNull();
  });

  test('returns null when sub claim is missing', async () => {
    const deps = makeStubDeps({
      jwtVerify: mock(async () => {
        const rawKey = {};
        const key = rawKey as unknown as CryptoKey;
        return {
          payload: { aud: AUDIENCE, iss: `https://${DOMAIN}/` },
          protectedHeader: { alg: 'RS256' },
          key,
        };
      }) as Auth0Deps['jwtVerify'],
    });
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('token-without-sub'));
    expect(principal).toBeNull();
  });

  test('provider name is "auth0"', () => {
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);
    expect(provider.name).toBe('auth0');
  });

  test('createRemoteJWKSet is called once at construction time with the correct URL', () => {
    const deps = makeStubDeps();
    createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);
    expect(deps.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    const url = (deps.createRemoteJWKSet as ReturnType<typeof mock>).mock.calls[0]?.[0] as URL;
    expect(url.href).toBe(`https://${DOMAIN}/.well-known/jwks.json`);
  });

  test('returns null when jwtVerify exceeds verifyTimeoutMs', async () => {
    // jwtVerify that never resolves — simulates a hung JWKS network call
    const hangingVerify = mock(
      () => new Promise<never>(() => {}),
    ) as unknown as Auth0Deps['jwtVerify'];

    const deps = makeStubDeps({ jwtVerify: hangingVerify });
    const provider = createAuth0AccessProvider(
      { domain: DOMAIN, audience: AUDIENCE, verifyTimeoutMs: 1 },
      deps,
    );

    const principal = await provider.verifyRequest(makeContext('valid.token'));
    expect(principal).toBeNull();
  });

  test('uses 5000ms default timeout when verifyTimeoutMs is omitted', async () => {
    // Verify that a fast jwtVerify still resolves correctly (timeout does not interfere)
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);

    const principal = await provider.verifyRequest(makeContext('valid.jwt.token'));
    expect(principal).not.toBeNull();
    expect(principal?.subject).toBe('auth0|user-123');
  });

  test('restricts JWT verification to the RS256 algorithm', async () => {
    // Auth0 issues RS256 by default. Pinning the alg list rejects `alg: none`
    // and any algorithm-substitution attempt that swaps to a weaker algorithm
    // the JWKS happens to also support.
    const deps = makeStubDeps();
    const provider = createAuth0AccessProvider({ domain: DOMAIN, audience: AUDIENCE }, deps);
    await provider.verifyRequest(makeContext('valid.jwt.token'));

    expect(deps.jwtVerify).toHaveBeenCalledTimes(1);
    const call = (deps.jwtVerify as ReturnType<typeof mock>).mock.calls[0];
    const options = call?.[2] as { algorithms?: string[] };
    expect(options.algorithms).toEqual(['RS256']);
    expect(options).toMatchObject({
      audience: AUDIENCE,
      issuer: `https://${DOMAIN}/`,
    });
  });
});
