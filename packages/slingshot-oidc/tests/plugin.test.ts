import { afterEach, describe, expect, mock, test } from 'bun:test';

let runtimeConfig: Record<string, unknown> = {};
let jwksLoaded = true;
const routeCalls: Array<{ base: string; router: unknown }> = [];

mock.module('@lastshotlabs/slingshot-auth', () => ({
  getAuthRuntimeContext: () => ({ config: runtimeConfig }),
}));

mock.module('@lastshotlabs/slingshot-core', () => ({
  getPluginStateOrNull: () => new Map(),
}));

mock.module('../src/lib/jwks', () => ({
  isJwksLoaded: () => jwksLoaded,
}));

mock.module('../src/routes/oidc', () => ({
  createOidcRouter: (config: unknown) => ({ kind: 'oidc-router', config }),
}));

afterEach(() => {
  runtimeConfig = {};
  jwksLoaded = true;
  routeCalls.length = 0;
  mock.restore();
});

describe('slingshot-oidc plugin', () => {
  test('fails closed when OIDC is not configured', async () => {
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

  test('mounts the OIDC router when config and signing keys are present', async () => {
    runtimeConfig = {
      oidc: { issuer: 'https://issuer.example.com' },
      jwks: { current: { kid: 'kid-1' } },
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

    expect(routeCalls).toEqual([
      {
        base: '/',
        router: { kind: 'oidc-router', config: runtimeConfig },
      },
    ]);
  });
});
