import { afterEach, describe, expect, test } from 'bun:test';
import { AUTH_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';

let runtimeConfig: Record<string, unknown> = {};
const routeCalls: Array<{ base: string; router: unknown }> = [];

function setupContext(): never {
  return {
    app: {
      pluginState: new Map([
        [
          AUTH_PLUGIN_STATE_KEY,
          {
            adapter: {},
            config: runtimeConfig,
          },
        ],
      ]),
      route(base: string, router: unknown) {
        routeCalls.push({ base, router });
      },
    },
  } as never;
}

afterEach(() => {
  runtimeConfig = {};
  routeCalls.length = 0;
});

describe('slingshot-oidc plugin', () => {
  test('fails closed when OIDC is not configured', async () => {
    // runtimeConfig has no oidc key — plugin should throw before mounting routes
    const { createOidcPlugin } = await import('../src/plugin');
    const plugin = createOidcPlugin();

    expect(() => plugin.setupRoutes?.(setupContext())).toThrow('OIDC is not configured');
    expect(routeCalls).toEqual([]);
  });

  test('fails closed when signing key is missing', async () => {
    // oidc configured but no signingKey — isJwksLoaded returns false
    runtimeConfig = { oidc: { issuer: 'https://issuer.example.com' } };

    const { createOidcPlugin } = await import('../src/plugin');
    const plugin = createOidcPlugin();

    expect(() => plugin.setupRoutes?.(setupContext())).toThrow('signing key');
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

    plugin.setupRoutes?.(setupContext());

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.base).toBe('/');
    // Router is a real Hono router — just verify it was passed
    expect(routeCalls[0]?.router).toBeDefined();
  });
});
