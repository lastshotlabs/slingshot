/**
 * Tests for F9 - SAML IdP metadata URL HTTPS enforcement.
 *
 * `initSaml` enforces HTTPS on the IdP metadata URL in an environment-aware way:
 *   - Production (`NODE_ENV='production'`): throws immediately with a clear error
 *   - Development (`NODE_ENV!='production'`): emits a console.warn and proceeds
 *     (the fetch will fail in test, but the guard itself does not throw)
 *
 * This lets developers test SAML locally using HTTP IdP stubs without
 * accidentally leaving insecure URLs in production config.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

mock.module('@authenio/samlify-xsd-schema-validator', () => ({
  validate: () => Promise.resolve('ok'),
}));

mock.module('samlify', () => ({
  setSchemaValidator: () => {},
  Constants: {
    BindingNamespace: {
      Post: 'post',
    },
  },
  ServiceProvider: () => ({
    createLoginRequest: () => ({
      id: 'request-id',
      context: 'ctx',
      entityEndpoint: 'https://idp.example.com/login',
    }),
    parseLoginResponse: async () => ({
      extract: {
        attributes: {},
        nameID: 'user@example.com',
      },
    }),
    getMetadata: () => '<xml />',
  }),
  IdentityProvider: ({ metadata }: { metadata: string }) => ({ metadata }),
}));

const DUMMY_CONFIG = {
  entityId: 'https://sp.example.com',
  acsUrl: 'https://sp.example.com/saml/acs',
  idpMetadata: '', // set per test
  signingCert: undefined,
  signingKey: undefined,
};

describe('initSaml - HTTPS enforcement (F9)', () => {
  let origEnv: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origEnv = process.env.NODE_ENV;
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    globalThis.fetch = origFetch;
  });

  test('throws in production when idpMetadata is an http:// URL', async () => {
    process.env.NODE_ENV = 'production';
    const { initSaml } = await import('../../src/lib/saml');

    await expect(
      initSaml({ ...DUMMY_CONFIG, idpMetadata: 'http://idp.example.com/metadata' }),
    ).rejects.toThrow('SAML IdP metadata URL must use HTTPS in production');
  });

  test('warns but does not throw in development when idpMetadata is an http:// URL', async () => {
    process.env.NODE_ENV = 'development';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { initSaml } = await import('../../src/lib/saml');
      // Should not throw the HTTPS guard - may throw a fetch/network error instead.
      await initSaml({ ...DUMMY_CONFIG, idpMetadata: 'http://idp.example.com/metadata' }).catch(
        (err: Error) => {
          expect(err.message).not.toContain('HTTPS in production');
        },
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[saml] WARNING: IdP metadata over HTTP — do not use in production',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('throws in production when an https:// metadata URL redirects to http://', async () => {
    process.env.NODE_ENV = 'production';
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('<EntityDescriptor>...</EntityDescriptor>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
      ).then(response => {
        Object.defineProperty(response, 'url', {
          configurable: true,
          value: 'http://idp.example.com/insecure-metadata',
        });
        return response;
      })) as unknown as typeof globalThis.fetch;

    const { initSaml } = await import('../../src/lib/saml');

    await expect(
      initSaml({ ...DUMMY_CONFIG, idpMetadata: 'https://idp.example.com/metadata' }),
    ).rejects.toThrow(
      'SAML IdP metadata URL must stay on HTTPS in production (redirect downgrade detected)',
    );
  });

  test('does NOT throw the guard error for https:// URLs', async () => {
    const { initSaml } = await import('../../src/lib/saml');

    let guardError = false;
    try {
      await initSaml({ ...DUMMY_CONFIG, idpMetadata: 'https://idp.example.com/metadata' });
    } catch (err) {
      if (/HTTPS in production/i.test((err as Error).message)) guardError = true;
    }

    expect(guardError).toBe(false);
  });

  test('XML string (not a URL) is accepted without triggering the guard', async () => {
    const { initSaml } = await import('../../src/lib/saml');

    let guardError = false;
    try {
      await initSaml({ ...DUMMY_CONFIG, idpMetadata: '<EntityDescriptor>...</EntityDescriptor>' });
    } catch (err) {
      if (/HTTPS in production/i.test((err as Error).message)) guardError = true;
    }

    expect(guardError).toBe(false);
  });
});
