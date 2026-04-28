import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig, HookContext } from '@auth/config/authConfig';
import { createMemorySamlRequestIdRepository, storeSamlRequestId } from '@auth/lib/samlRequestId';
import { createSamlRouter } from '@auth/routes/saml';
import type { AuthRuntimeContext } from '@auth/runtime';
import { beforeEach, describe, expect, test } from 'bun:test';
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
import { HttpError, createInProcessAdapter } from '@lastshotlabs/slingshot-core';

const mockSaml = {
  initSaml: async () => ({ sp: {} as any, idp: {} as any }),
  createAuthnRequest: () => ({
    redirectUrl: 'https://idp.example.com/sso',
    id: 'req-id',
  }),
  validateSamlResponse: async () => ({
    nameId: 'saml-name-id-123',
    email: 'saml@example.com',
    firstName: 'Sam',
    lastName: 'Luser',
    displayName: 'Sam Luser',
    attributes: {},
  }),
  samlProfileToIdentityProfile: () => ({
    email: 'saml@example.com',
    firstName: 'Sam',
    lastName: 'Luser',
    displayName: 'Sam Luser',
  }),
  getSamlSpMetadata: () => '<EntityDescriptor />',
} as unknown as typeof import('@auth/lib/saml');

const TEST_SIGNING = { secret: 'test-secret-key-must-be-at-least-32-chars!!' };

describe('SAML login parity', () => {
  let config: AuthResolvedConfig;
  let preLoginCalls: Array<{ identifier: string } & HookContext>;
  let loginSuccessEvents: Array<{ userId: string; sessionId?: string }>;
  let authLoginEvents: Array<{ userId: string; sessionId: string }>;

  beforeEach(() => {
    preLoginCalls = [];
    loginSuccessEvents = [];
    authLoginEvents = [];

    config = {
      ...DEFAULT_AUTH_CONFIG,
      hooks: {
        ...DEFAULT_AUTH_CONFIG.hooks,
        preLogin: async data => {
          preLoginCalls.push(data);
        },
      },
      saml: {
        entityId: 'https://app.example.com',
        acsUrl: 'https://app.example.com/auth/saml/acs',
        idpMetadata: '<EntityDescriptor />',
        postLoginRedirect: '/after-saml',
        onLogin: async () => ({ userId: 'user-saml-1' }),
      },
    };
  });

  test('ACS runs preLogin and emits the standard login events', async () => {
    const samlRequestIdRepo = createMemorySamlRequestIdRepository();
    const eventBus = createInProcessAdapter();
    eventBus.on('security.auth.login.success', payload => {
      loginSuccessEvents.push(payload);
    });
    eventBus.on('auth:login', payload => {
      authLoginEvents.push(payload);
    });
    const events = {
      publish: (key: string, payload: unknown) => {
        eventBus.emit(key as never, payload as never);
        return { key, payload };
      },
    };

    const runtime = {
      adapter: {} as any,
      eventBus,
      events,
      config,
      stores: {
        sessions: 'memory',
        oauthState: 'memory',
        authStore: 'memory',
        cache: 'memory',
        sqlite: undefined,
      },
      signing: TEST_SIGNING,
      dataEncryptionKeys: [],
      oauth: {
        providers: {},
        stateStore: { store: async () => {}, consume: async () => null },
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
        samlRequestId: samlRequestIdRepo,
        verificationToken: createMemoryVerificationTokenRepository(),
        resetToken: createMemoryResetTokenRepository(),
        session: createMemorySessionRepository(),
      },
    } as unknown as AuthRuntimeContext;

    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    app.route('/', createSamlRouter(runtime, mockSaml));

    const requestId = 'saml-request-id-123';
    await storeSamlRequestId(samlRequestIdRepo, requestId);
    const samlResponse = Buffer.from(`<Response InResponseTo="${requestId}"></Response>`).toString(
      'base64',
    );
    const body = new URLSearchParams({ SAMLResponse: samlResponse });

    const res = await app.request('/auth/saml/acs', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'saml-test-agent/1.0',
      },
      body: body.toString(),
    });

    expect(res.status).toBe(302);
    expect(preLoginCalls).toHaveLength(1);
    expect(preLoginCalls[0].identifier).toBe('saml@example.com');
    expect(loginSuccessEvents).toHaveLength(1);
    expect(loginSuccessEvents[0].userId).toBe('user-saml-1');
    expect(authLoginEvents).toHaveLength(1);
    expect(authLoginEvents[0].userId).toBe('user-saml-1');
    expect(authLoginEvents[0].sessionId).toBeString();
  });
});
