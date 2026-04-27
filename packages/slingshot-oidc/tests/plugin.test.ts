import { afterEach, describe, expect, mock, test } from 'bun:test';

let runtimeConfig: Record<string, unknown> = {};
const routeCalls: Array<{ base: string; router: unknown }> = [];

// Only mock slingshot-auth to control the auth runtime context.
// slingshot-core and local modules are used as-is to avoid cross-test contamination.
mock.module('@lastshotlabs/slingshot-auth', () => ({
  getAuthRuntimeContext: () => ({ config: runtimeConfig }),
}));

afterEach(() => {
  runtimeConfig = {};
  routeCalls.length = 0;
  mock.restore();
});

describe('slingshot-oidc plugin', () => {
  test('fails closed when OIDC is not configured', async () => {
    // runtimeConfig has no oidc key — plugin should throw before mounting routes
    const { createOidcPlugin } = await import('../src/plugin');
    const plugin = createOidcPlugin();

    expect(() =>
      plugin.setupRoutes?.({
        app: {
          route(base: string, router: unknown) {
            routeCalls.push({ base, router });
          },
        },
      } as never),
    ).toThrow('OIDC is not configured');
    expect(routeCalls).toEqual([]);
  });

  test('fails closed when signing key is missing', async () => {
    // oidc configured but no signingKey — isJwksLoaded returns false
    runtimeConfig = { oidc: { issuer: 'https://issuer.example.com' } };

    const { createOidcPlugin } = await import('../src/plugin');
    const plugin = createOidcPlugin();

    expect(() =>
      plugin.setupRoutes?.({
        app: {
          route(base: string, router: unknown) {
            routeCalls.push({ base, router });
          },
        },
      } as never),
    ).toThrow('signing key');
    expect(routeCalls).toEqual([]);
  });

  test('mounts the OIDC router when config and signing keys are present', async () => {
    // Provide a signingKey so isJwksLoaded returns true (uses real implementation)
    runtimeConfig = {
      oidc: {
        issuer: 'https://issuer.example.com',
        signingKey: { privateKey: 'fake-priv', publicKey: 'fake-pub' },
      },
    };

    const { createOidcPlugin } = await import('../src/plugin');
    const plugin = createOidcPlugin();

    plugin.setupRoutes?.({
      app: {
        route(base: string, router: unknown) {
          routeCalls.push({ base, router });
        },
      },
    } as never);

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.base).toBe('/');
    // Router is a real Hono router — just verify it was passed
    expect(routeCalls[0]?.router).toBeDefined();
  });
});
