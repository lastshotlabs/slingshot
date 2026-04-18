import { createAuth0AccessProvider } from '@admin/providers/auth0Access';
import type { Auth0Deps } from '@admin/providers/auth0Access';
import { describe, expect, mock, test } from 'bun:test';
import type { AdminPrincipal } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Jose function mocks — injected via deps parameter, no module-level mock needed.
// ---------------------------------------------------------------------------

const mockJwtVerify = mock(async (_token: any, _keyset: any, _opts: any) => ({
  payload: {
    sub: 'auth0|user-123',
    email: 'admin@example.com',
    name: 'Admin User',
    'https://admin': true,
  },
}));

const mockCreateRemoteJWKSet = mock((_url: URL) => 'mock-jwks' as any);

const deps = {
  jwtVerify: mockJwtVerify,
  createRemoteJWKSet: mockCreateRemoteJWKSet,
} as unknown as Auth0Deps;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(authorizationHeader?: string): any {
  return {
    req: {
      header: (name: string) => (name === 'authorization' ? authorizationHeader : undefined),
    },
  };
}

const defaultConfig = {
  domain: 'myapp.auth0.com',
  audience: 'https://api.myapp.com',
};

// ---------------------------------------------------------------------------
// verifyRequest — header validation
// ---------------------------------------------------------------------------

describe('createAuth0AccessProvider — verifyRequest: header validation', () => {
  test('returns null when Authorization header is absent', async () => {
    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext(undefined));
    expect(result).toBeNull();
  });

  test('returns null when Authorization header is empty string', async () => {
    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext(''));
    expect(result).toBeNull();
  });

  test('returns null when header does not start with "Bearer "', async () => {
    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Token some-token'));
    expect(result).toBeNull();
  });

  test('returns null when header is exactly "Bearer " with no token', async () => {
    // jwtVerify would throw for an empty token string; the catch block returns null
    mockJwtVerify.mockImplementationOnce(async () => {
      throw new Error('invalid token');
    });
    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer '));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyRequest — valid token
// ---------------------------------------------------------------------------

describe('createAuth0AccessProvider — verifyRequest: valid token', () => {
  test('returns AdminPrincipal with subject, email, and rawClaims on success', async () => {
    mockJwtVerify.mockImplementationOnce(async () => ({
      payload: {
        sub: 'auth0|user-42',
        email: 'user@example.com',
        name: 'Test User',
        'https://admin': true,
      },
    }));

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer valid.jwt.token'));

    expect(result).not.toBeNull();
    const principal = result as AdminPrincipal;
    expect(principal.subject).toBe('auth0|user-42');
    expect(principal.email).toBe('user@example.com');
    expect(principal.displayName).toBe('Test User');
    expect(principal.provider).toBe('auth0');
    expect(principal.rawClaims).toBeDefined();
    expect(principal.rawClaims!['https://admin']).toBe(true);
  });

  test('passes audience from config to jwtVerify', async () => {
    let capturedOpts: any;
    (mockJwtVerify as any).mockImplementationOnce(async (_tok: any, _ks: any, opts: any) => {
      capturedOpts = opts;
      return { payload: { sub: 'u', email: '', name: '' } };
    });

    const provider = createAuth0AccessProvider(
      {
        domain: 'myapp.auth0.com',
        audience: 'https://specific-audience.example.com',
      },
      deps,
    );
    await provider.verifyRequest(makeContext('Bearer some.token'));

    expect(capturedOpts?.audience).toBe('https://specific-audience.example.com');
  });

  test('returns undefined (not empty string) for missing email in payload', async () => {
    (mockJwtVerify as any).mockImplementationOnce(async () => ({
      payload: { sub: 'auth0|user-no-email', name: 'No Email User' },
    }));

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer some.token'));
    expect(result).not.toBeNull();
    expect((result as AdminPrincipal).email).toBeUndefined();
  });

  test('returns undefined (not empty string) for missing name in payload', async () => {
    (mockJwtVerify as any).mockImplementationOnce(async () => ({
      payload: { sub: 'auth0|user-no-name', email: 'noname@example.com' },
    }));

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer some.token'));
    expect(result).not.toBeNull();
    expect((result as AdminPrincipal).displayName).toBeUndefined();
  });

  test('returns null when sub is missing from payload', async () => {
    (mockJwtVerify as any).mockImplementationOnce(async () => ({
      payload: { email: 'no-sub@example.com' },
    }));

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer some.token'));

    // sub is required — missing sub is treated as an invalid token
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyRequest — jwtVerify throws
// ---------------------------------------------------------------------------

describe('createAuth0AccessProvider — verifyRequest: jwtVerify error', () => {
  test('returns null when jwtVerify throws', async () => {
    mockJwtVerify.mockImplementationOnce(async () => {
      throw new Error('invalid signature');
    });

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer bad.token'));
    expect(result).toBeNull();
  });

  test('returns null when jwtVerify rejects with expired token error', async () => {
    mockJwtVerify.mockImplementationOnce(async () => {
      throw new Error('JWTExpired: token expired');
    });

    const provider = createAuth0AccessProvider(defaultConfig, deps);
    const result = await provider.verifyRequest(makeContext('Bearer expired.token'));
    expect(result).toBeNull();
  });
});

// Note: getCapabilities is on ManagedUserProvider, not AdminAccessProvider.
// See slingshotUsers.test.ts for capability tests.
