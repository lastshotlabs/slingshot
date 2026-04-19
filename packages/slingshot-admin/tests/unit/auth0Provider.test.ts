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
    createRemoteJWKSet: mock(() => (() => Promise.resolve({} as never)) as never) as Auth0Deps['createRemoteJWKSet'],
    // cast needed: jose's JWTVerifyResult requires a `key` field (ResolvedKey) that
    // is not present in test payloads
    jwtVerify: mock(async () => {
      const key: CryptoKey = {} as never;
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
  const ctx: never = {
    req: {
      header: (name: string) => {
        if (name === 'authorization') return token ? `Bearer ${token}` : undefined;
        return undefined;
      },
    },
  } as never;
  return ctx;
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

    const ctx: never = {
      req: {
        header: (name: string) => (name === 'authorization' ? 'Basic credentials' : undefined),
      },
    } as never;
    const principal = await provider.verifyRequest(ctx);
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
        const key: CryptoKey = {} as never;
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
});
