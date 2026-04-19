import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import { createMemoryOAuthStateStore } from '@auth/lib/oauth';
import {
  consumeSamlRequestId,
  createMemorySamlRequestIdRepository,
  storeSamlRequestId,
} from '@auth/lib/samlRequestId';
import type { SamlRequestIdRepository } from '@auth/lib/samlRequestId';
import { csrfProtection } from '@auth/middleware/csrf';
import { createSamlRouter } from '@auth/routes/saml';
import type { AuthRuntimeContext } from '@auth/runtime';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
  createMemoryDeletionCancelTokenRepository,
  createMemoryMagicLinkRepository,
  createMemoryMfaChallengeRepository,
  createMemoryOAuthCodeRepository,
  createMemoryOAuthReauthRepository,
  createMemoryResetTokenRepository,
  createMemorySessionRepository,
  createMemoryVerificationTokenRepository,
} from '@lastshotlabs/slingshot-auth/testing';
import { COOKIE_CSRF_TOKEN, HttpError } from '@lastshotlabs/slingshot-core';

let config: AuthResolvedConfig;
let samlRequestIdRepo: SamlRequestIdRepository;

beforeEach(() => {
  config = { ...DEFAULT_AUTH_CONFIG };
  samlRequestIdRepo = createMemorySamlRequestIdRepository();
});

function createRuntime(
  resolvedConfig: AuthResolvedConfig,
  options?: {
    samlRepo?: SamlRequestIdRepository;
    signing?: AuthRuntimeContext['signing'];
  },
): AuthRuntimeContext {
  const emptyAdapter = {};
  return {
    adapter: emptyAdapter as AuthRuntimeContext['adapter'],
    eventBus: { emit() {} } as unknown as AuthRuntimeContext['eventBus'],
    config: resolvedConfig,
    stores: {
      sessions: 'memory',
      oauthState: 'memory',
      authStore: 'memory',
      cache: 'memory',
      sqlite: undefined,
    },
    signing: options?.signing ?? null,
    dataEncryptionKeys: [],
    oauth: {
      providers: {},
      stateStore: createMemoryOAuthStateStore(),
    },
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    queueFactory: null,
    repos: {
      oauthCode: createMemoryOAuthCodeRepository(),
      oauthReauth: createMemoryOAuthReauthRepository(),
      magicLink: createMemoryMagicLinkRepository(),
      deletionCancelToken: createMemoryDeletionCancelTokenRepository(),
      mfaChallenge: createMemoryMfaChallengeRepository(),
      samlRequestId: options?.samlRepo ?? createMemorySamlRequestIdRepository(),
      verificationToken: createMemoryVerificationTokenRepository(),
      resetToken: createMemoryResetTokenRepository(),
      session: createMemorySessionRepository(),
    },
  } as unknown as AuthRuntimeContext;
}

function createErrorApp(runtime: AuthRuntimeContext) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404);
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.route('/', createSamlRouter(runtime));
  return app;
}

function extractCookie(res: Response, name: string): string | null {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`));
    if (match) return match[1] ?? null;
  }

  const fallback = res.headers.get('set-cookie');
  if (!fallback) return null;
  const match = fallback.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? null;
}

describe('SAML routes - not configured', () => {
  function buildApp() {
    return createErrorApp(createRuntime(config, { samlRepo: samlRequestIdRepo }));
  }

  test('POST /auth/saml/login returns 404 when not configured', async () => {
    const app = buildApp();
    const res = await app.request('/auth/saml/login', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /auth/saml/acs returns 404 when not configured', async () => {
    const app = buildApp();
    const res = await app.request('/auth/saml/acs', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('GET /auth/saml/metadata returns 404 when not configured', async () => {
    const app = buildApp();
    const res = await app.request('/auth/saml/metadata');
    expect(res.status).toBe(404);
  });
});

describe('SAML login initiation CSRF protection', () => {
  function createMockSamlImpl(): typeof import('@auth/lib/saml') {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return {
      initSaml: async () => ({
        sp: {
          createLoginRequest() {
            return {
              id: 'saml-request-1',
              context: 'SAMLRequest=stub',
              entityEndpoint: 'https://idp.example.com/sso',
            };
          },
          async parseLoginResponse() {
            throw new Error('parseLoginResponse should not run in login-initiation tests');
          },
          getMetadata() {
            return '<xml />';
          },
        },
        idp: {},
      }),
      createAuthnRequest: () => ({
        redirectUrl: 'https://idp.example.com/sso?SAMLRequest=stub',
        id: 'saml-request-1',
      }),
      validateSamlResponse: async () => {
        throw new Error('validateSamlResponse should not run in login-initiation tests');
      },
      samlProfileToIdentityProfile: () => ({}),
      getSamlSpMetadata: () => '<xml />',
    } as typeof import('@auth/lib/saml');
  }

  function buildApp() {
    const runtime = createRuntime(
      {
        ...config,
        saml: {
          entityId: 'https://app.example.com/auth/saml/metadata',
          acsUrl: 'https://app.example.com/auth/saml/acs',
          idpMetadata: '<EntityDescriptor>...</EntityDescriptor>',
        },
      },
      {
        signing: { secret: 'test-csrf-secret' },
      },
    );

    const app = new Hono();
    app.use(
      '*',
      csrfProtection({
        checkOrigin: false,
        signing: runtime.signing,
        protectedUnauthenticatedPaths: ['/auth/saml/login'],
      }),
    );
    app.get('/csrf', c => c.json({ ok: true }));
    app.route('/', createSamlRouter(runtime, createMockSamlImpl()));
    return app;
  }

  test('anonymous POST /auth/saml/login rejects requests without CSRF proof', async () => {
    const app = buildApp();

    const res = await app.request('/auth/saml/login', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'CSRF token missing' });
  });

  test('anonymous POST /auth/saml/login succeeds with a matching CSRF header', async () => {
    const app = buildApp();
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/saml/login?redirect=%2Fdashboard', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_CSRF_TOKEN}=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example.com/sso');
    expect(url.searchParams.get('SAMLRequest')).toBe('stub');
    expect(url.searchParams.get('RelayState')).toBeTruthy();
  });

  test('GET /auth/saml/login is no longer mounted', async () => {
    const app = buildApp();

    const res = await app.request('/auth/saml/login');

    expect(res.status).toBe(404);
  });
});

describe('SamlConfig type', () => {
  test('config stores saml config', () => {
    const samlConfig = {
      entityId: 'https://app.example.com',
      acsUrl: 'https://app.example.com/auth/saml/acs',
      idpMetadata: '<EntityDescriptor>...</EntityDescriptor>',
    };
    config = { ...config, saml: samlConfig };
    expect(config.saml).toEqual(samlConfig);
  });
});

// ---------------------------------------------------------------------------
// F-7a: HTTPS enforcement for SAML metadata
// ---------------------------------------------------------------------------

describe('SAML HTTPS enforcement', () => {
  test('initSaml throws on http:// URL in production', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { initSaml } = await import('@auth/lib/saml');
      await expect(
        initSaml({
          entityId: 'https://app.example.com',
          acsUrl: 'https://app.example.com/auth/saml/acs',
          idpMetadata: 'http://idp.example.com/metadata',
        }),
      ).rejects.toThrow('SAML IdP metadata URL must use HTTPS in production');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('initSaml warns but does not throw on http:// URL in development', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { initSaml } = await import('@auth/lib/saml');
      await initSaml({
        entityId: 'https://app.example.com',
        acsUrl: 'https://app.example.com/auth/saml/acs',
        idpMetadata: 'http://idp.example.com/metadata',
      }).catch((err: Error) => {
        expect(err.message).not.toContain('HTTPS in production');
      });
      expect(warnSpy.mock.calls.map(call => call[0])).toContain(
        '[saml] WARNING: IdP metadata over HTTP — do not use in production',
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// F-7b: SAML request ID store
// ---------------------------------------------------------------------------

describe('SAML request ID store (memory)', () => {
  test('store + consume round-trip returns true', async () => {
    const id = 'saml-request-id-123';
    await storeSamlRequestId(samlRequestIdRepo, id);
    const result = await consumeSamlRequestId(samlRequestIdRepo, id);
    expect(result).toBe(true);
  });

  test('consume is single-use - second consume returns false', async () => {
    const id = 'saml-request-id-456';
    await storeSamlRequestId(samlRequestIdRepo, id);
    expect(await consumeSamlRequestId(samlRequestIdRepo, id)).toBe(true);
    expect(await consumeSamlRequestId(samlRequestIdRepo, id)).toBe(false);
  });

  test('consuming unknown request ID returns false', async () => {
    expect(await consumeSamlRequestId(samlRequestIdRepo, 'nonexistent-id')).toBe(false);
  });

  test('expired request IDs are not consumable', async () => {
    const { sha256 } = await import('@lastshotlabs/slingshot-core');
    const id = 'expired-request-id';
    const hash = sha256(id);

    await storeSamlRequestId(samlRequestIdRepo, id);

    expect(await consumeSamlRequestId(samlRequestIdRepo, hash)).toBe(false);
    expect(await consumeSamlRequestId(samlRequestIdRepo, id)).toBe(true);
  });

  test('fresh repo has no entries (simulates clear)', async () => {
    await storeSamlRequestId(samlRequestIdRepo, 'id-a');
    await storeSamlRequestId(samlRequestIdRepo, 'id-b');
    const freshRepo = createMemorySamlRequestIdRepository();
    expect(await consumeSamlRequestId(freshRepo, 'id-a')).toBe(false);
    expect(await consumeSamlRequestId(freshRepo, 'id-b')).toBe(false);
  });

  test('request IDs are stored as SHA-256 hashes (not plaintext)', async () => {
    const id = 'my-request-id';
    await storeSamlRequestId(samlRequestIdRepo, id);
    const { sha256 } = await import('@lastshotlabs/slingshot-core');
    const hash = sha256(id);
    expect(await consumeSamlRequestId(samlRequestIdRepo, hash)).toBe(false);
    expect(await consumeSamlRequestId(samlRequestIdRepo, id)).toBe(true);
  });
});
