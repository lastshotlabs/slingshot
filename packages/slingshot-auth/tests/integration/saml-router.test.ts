import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { verifyToken } from '../../src/lib/jwt';
import {
  createMemorySamlRequestIdRepository,
  storeSamlRequestId,
} from '../../src/lib/samlRequestId';
import { createSamlRouter } from '../../src/routes/saml';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';
import type { SamlProfile, SamlifySpInstance } from '../../src/lib/saml';

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  const sp: SamlifySpInstance = {
    createLoginRequest: () => ({
      id: 'req-1',
      context: 'SAMLRequest=test',
      entityEndpoint: 'https://idp.example.test/login',
    }),
    parseLoginResponse: async () => ({
      extract: {
        attributes: { email: 'saml-user@example.com' },
        nameID: 'saml-user-1',
      },
    }),
    getMetadata: () => '<xml />',
  };
  const profile: SamlProfile = {
    nameId: 'saml-user-1',
    email: 'saml-user@example.com',
    attributes: { email: 'saml-user@example.com' },
  };
  const samlImpl = {
    initSaml: async () => ({ sp, idp: { entityId: 'idp' } }),
    createAuthnRequest: () => ({ redirectUrl: 'https://idp.example.test/login', id: 'req-1' }),
    validateSamlResponse: async () => profile,
    samlProfileToIdentityProfile: (profile: SamlProfile) => ({
      email: profile.email,
    }),
    getSamlSpMetadata: () => '<xml />',
  } satisfies Pick<
    typeof import('../../src/lib/saml'),
    | 'initSaml'
    | 'createAuthnRequest'
    | 'validateSamlResponse'
    | 'samlProfileToIdentityProfile'
    | 'getSamlSpMetadata'
  >;

  app.route('/', createSamlRouter(runtime, samlImpl));
  return app;
}

describe('SAML router', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime({
      saml: {
        entityId: 'https://app.example.com/auth/saml',
        acsUrl: 'https://app.example.com/auth/saml/acs',
        idpMetadata: 'https://idp.example.com/metadata',
        postLoginRedirect: '/dashboard',
      },
      emailVerification: { required: false },
    });
    runtime.eventBus = makeEventBus();
    Object.assign(runtime.repos, { samlRequestId: createMemorySamlRequestIdRepository() });
    app = buildApp(runtime);
  });

  test('SAML login does not automatically satisfy local MFA freshness', async () => {
    const requestId = 'req-1';
    const encoded = Buffer.from(`<Response InResponseTo="${requestId}" />`, 'utf8').toString(
      'base64',
    );
    await storeSamlRequestId(runtime.repos.samlRequestId!, requestId);

    const res = await app.request('/auth/saml/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLResponse: encoded }).toString(),
    });

    expect(res.status).toBe(302);
    const setCookieHeaders = res.headers.getSetCookie();
    const tokenCookie = setCookieHeaders.find(header => header.startsWith('token='));
    expect(tokenCookie).toBeString();

    const cookieValue = tokenCookie!.split(';')[0]!.split('=')[1]!;
    const payload = await verifyToken(cookieValue, runtime.config, runtime.signing);
    const sessionId = payload.sid as string;
    expect(sessionId).toBeString();
    expect(await runtime.repos.session.getMfaVerifiedAt(sessionId)).toBeNull();
  });
});
