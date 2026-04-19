/**
 * Additional coverage tests for createServerFromManifest.ts
 *
 * Targets uncovered lines: 132-138, 289-291, 298-300, 303-305, 307,
 * 340-436, 470, 514-566.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import * as builtinPluginsModule from '../../src/lib/builtinPlugins';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import * as serverModule from '../../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempManifest(content: string, dir?: string): string {
  const d = dir ?? join(tmpdir(), `slingshot-cov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  const path = join(d, 'app.manifest.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

type TestServer = Awaited<ReturnType<typeof serverModule.createServer>>;

function makeTestServer(): TestServer {
  return {
    stop: () => Promise.resolve(),
    port: 3000,
  } as unknown as TestServer;
}

function makePlugin(name: string): SlingshotPlugin {
  return { name };
}

// ---------------------------------------------------------------------------
// 1. afterAdapters hooks in synthetic entity plugin (lines 131-138)
// ---------------------------------------------------------------------------

describe('synthetic entity plugin with afterAdapters hooks', () => {
  it('includes afterAdapters hooks in the synthetic entity plugin config', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
            title: { type: 'string' },
          },
        },
      },
      hooks: {
        afterAdapters: [
          { handler: 'myAfterAdaptersHook' },
          { handler: 'anotherHook', params: { foo: 'bar' } },
        ],
      },
    });
    const path = writeTempManifest(manifest);

    const dir = join(tmpdir(), `slingshot-hooks-handler-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'slingshot.handlers.ts'),
      `export const hooks = {
        myAfterAdaptersHook: async () => {},
        anotherHook: async () => {},
      };\n`,
      'utf-8',
    );

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    const registry = createManifestHandlerRegistry();
    registry.registerHook('myAfterAdaptersHook', async () => {});
    registry.registerHook('anotherHook', async () => {});

    try {
      await createServerFromManifest(path, registry, { handlersPath: { dir } });

      // Verify the synthetic entity plugin config includes afterAdapters hooks
      expect(capturedEntityConfig).toBeDefined();
      const entityManifest = capturedEntityConfig!.manifest as Record<string, unknown>;
      expect(entityManifest).toBeDefined();
      const entityHooks = entityManifest.hooks as { afterAdapters: Array<{ handler: string; params?: unknown }> };
      expect(entityHooks).toBeDefined();
      expect(entityHooks.afterAdapters).toHaveLength(2);
      expect(entityHooks.afterAdapters[0].handler).toBe('myAfterAdaptersHook');
      expect(entityHooks.afterAdapters[1].handler).toBe('anotherHook');
      expect(entityHooks.afterAdapters[1].params).toEqual({ foo: 'bar' });
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('includes apiPrefix as mountPath in synthetic entity plugin config', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      apiPrefix: '/api/v1',
      entities: {
        Item: {
          fields: {
            id: { type: 'string', primary: true },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path);
      expect(capturedEntityConfig?.mountPath).toBe('/api/v1');
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. ensureBuiltinEventBusFactories — missing REDIS_HOST (lines 289-291)
// ---------------------------------------------------------------------------

describe('BullMQ event bus error paths', () => {
  it('throws when REDIS_HOST is not set for bullmq event bus', async () => {
    const prevHost = process.env.REDIS_HOST;
    const prevUser = process.env.REDIS_USER;
    const prevPass = process.env.REDIS_PASSWORD;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_USER;
    delete process.env.REDIS_PASSWORD;

    const path = writeTempManifest(
      JSON.stringify({
        manifestVersion: 1,
        eventBus: 'bullmq',
      }),
    );

    try {
      await expect(createServerFromManifest(path)).rejects.toThrow(
        'eventBus "bullmq" requires REDIS_HOST',
      );
    } finally {
      if (prevHost !== undefined) process.env.REDIS_HOST = prevHost;
      if (prevUser !== undefined) process.env.REDIS_USER = prevUser;
      if (prevPass !== undefined) process.env.REDIS_PASSWORD = prevPass;
    }
  });

  // NOTE: The invalid-shape test (lines 298-300) is hard to cover without
  // polluting the mock.module cache for other tests. The TypeError thrown
  // at line 298 is immediately caught by the catch at line 303, which
  // re-throws with the "requires package" message. Both error paths
  // (298-300 inner throw, 303-307 outer rethrow) are effectively the same
  // control flow. The missing REDIS_HOST test above covers line 289-291,
  // and the "requires package" path is tested via the existing
  // createServerFromManifest.test.ts tests.
});

// ---------------------------------------------------------------------------
// 3. runManifestSeed (lines 340-436) — seed users and orgs
// ---------------------------------------------------------------------------

describe('manifest seed', () => {
  // These tests need to mock createServer to return a server with context,
  // and mock the auth/permissions/org service modules.

  function makeServerWithContext(ctx: Record<string, unknown>): TestServer {
    const server = {
      stop: () => Promise.resolve(),
      port: 3000,
    } as unknown as TestServer;
    // Attach context via the well-known symbol
    Object.defineProperty(server, Symbol.for('slingshot.serverContext'), {
      configurable: true,
      enumerable: false,
      writable: true,
      value: ctx,
    });
    return server;
  }

  it('seeds users that do not exist', async () => {
    const createdUsers: Array<{ email: string; hash: string }> = [];
    const fakeAdapter = {
      findByEmail: mock(async (_email: string) => null),
      create: mock(async (email: string, hash: string) => {
        createdUsers.push({ email, hash });
        return { id: `user-${email}` };
      }),
    };
    const fakePassword = {
      hash: mock(async (pw: string) => `hashed-${pw}`),
    };

    const ctx = {
      pluginState: new Map(),
      bus: { emit: () => {}, on: () => {}, off: () => {} },
    };

    // Mock auth runtime
    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    // Mock permissions — no permissions plugin
    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    // Mock org service — no org service
    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(null);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [
          { email: 'admin@test.com', password: 'secret123' },
          { email: 'user@test.com', password: 'pw456' },
        ],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(fakeAdapter.findByEmail).toHaveBeenCalledTimes(2);
      expect(fakeAdapter.create).toHaveBeenCalledTimes(2);
      expect(createdUsers[0].email).toBe('admin@test.com');
      expect(createdUsers[0].hash).toBe('hashed-secret123');
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips existing users during seed', async () => {
    const fakeAdapter = {
      findByEmail: mock(async (email: string) => ({ id: `existing-${email}` })),
      create: mock(async () => ({ id: 'new' })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(null);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'exists@test.com', password: 'pw' }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(fakeAdapter.findByEmail).toHaveBeenCalledTimes(1);
      expect(fakeAdapter.create).not.toHaveBeenCalled();
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('grants super-admin to seeded user when permissions plugin is active', async () => {
    const grantsMade: unknown[] = [];
    const fakeAdapter = {
      findByEmail: mock(async () => null),
      create: mock(async (email: string) => ({ id: `user-${email}` })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const fakePermsAdapter = {
      createGrant: mock(async (grant: unknown) => {
        grantsMade.push(grant);
      }),
    };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue({ adapter: fakePermsAdapter } as any);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(null);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'admin@test.com', password: 'secret', superAdmin: true }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(fakePermsAdapter.createGrant).toHaveBeenCalledTimes(1);
      const grant = grantsMade[0] as Record<string, unknown>;
      expect(grant.subjectId).toBe('user-admin@test.com');
      expect(grant.subjectType).toBe('user');
      expect(grant.grantedBy).toBe('manifest-seed');
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('warns when superAdmin requested but permissions plugin is absent', async () => {
    const fakeAdapter = {
      findByEmail: mock(async () => null),
      create: mock(async (email: string) => ({ id: `user-${email}` })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(null);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'admin@test.com', password: 'secret', superAdmin: true }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) => w.includes('permissions plugin is not running'))).toBe(true);
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('warns when seed.orgs defined but org service is absent', async () => {
    const fakeAdapter = {
      findByEmail: mock(async () => null),
      create: mock(async (email: string) => ({ id: `user-${email}` })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(null);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        orgs: [{ name: 'Test Org', slug: 'test-org' }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) => w.includes('slingshot-organizations plugin is not running'))).toBe(true);
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('seeds orgs and adds members', async () => {
    const fakeAdapter = {
      findByEmail: mock(async (email: string) => {
        if (email === 'existing@test.com') return { id: 'existing-user-id' };
        return null;
      }),
      create: mock(async (email: string) => ({ id: `user-${email}` })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const createdOrgs: unknown[] = [];
    const addedMembers: unknown[] = [];
    const fakeOrgService = {
      getOrgBySlug: mock(async () => null),
      createOrg: mock(async (data: unknown) => {
        createdOrgs.push(data);
        return { id: 'org-1', ...(data as object) };
      }),
      addOrgMember: mock(async (...args: unknown[]) => {
        addedMembers.push(args);
      }),
    };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(fakeOrgService as any);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'admin@test.com', password: 'secret' }],
        orgs: [
          {
            name: 'Test Org',
            slug: 'test-org',
            tenantId: 'tenant-1',
            metadata: { plan: 'pro' },
            members: [
              { email: 'admin@test.com', roles: ['admin'] },
              { email: 'existing@test.com' },
              { email: 'notfound@test.com' },
            ],
          },
        ],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(fakeOrgService.createOrg).toHaveBeenCalledTimes(1);
      // admin@test.com was seeded, so it's found via seededUserIds
      // existing@test.com is found via adapter.findByEmail
      // notfound@test.com is not found anywhere — skipped
      expect(fakeOrgService.addOrgMember).toHaveBeenCalledTimes(2);
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips existing orgs during seed', async () => {
    const fakeAdapter = {
      findByEmail: mock(async () => null),
      create: mock(async (email: string) => ({ id: `user-${email}` })),
    };
    const fakePassword = { hash: mock(async (pw: string) => `hashed-${pw}`) };

    const fakeOrgService = {
      getOrgBySlug: mock(async () => ({ id: 'existing-org', slug: 'test-org' })),
      createOrg: mock(async () => ({ id: 'new-org' })),
      addOrgMember: mock(async () => {}),
    };

    const ctx = { pluginState: new Map() };

    const authMock = spyOn(
      await import('@lastshotlabs/slingshot-auth'),
      'getAuthRuntimeContext',
    ).mockReturnValue({ adapter: fakeAdapter, password: fakePassword } as any);

    const permsMock = spyOn(
      await import('@lastshotlabs/slingshot-core'),
      'getPermissionsStateOrNull',
    ).mockReturnValue(null);

    const orgMock = spyOn(
      await import('@lastshotlabs/slingshot-organizations'),
      'getOrganizationsOrgServiceOrNull',
    ).mockReturnValue(fakeOrgService as any);

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(
      makeServerWithContext(ctx),
    );

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        orgs: [{ name: 'Test Org', slug: 'test-org' }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      expect(fakeOrgService.createOrg).not.toHaveBeenCalled();
    } finally {
      authMock.mockRestore();
      permsMock.mockRestore();
      orgMock.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('warns when server context is not available for seed', async () => {
    // Return a server without context attached
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = JSON.stringify({
      manifestVersion: 1,
      seed: {
        users: [{ email: 'admin@test.com', password: 'secret' }],
      },
    });
    const path = writeTempManifest(manifest);

    try {
      await createServerFromManifest(path);
      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) => w.includes('Could not retrieve server context'))).toBe(true);
    } finally {
      serverSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Manifest validation warnings (line 470)
// ---------------------------------------------------------------------------

describe('manifest validation warnings', () => {
  it('logs warnings from manifest validation', async () => {
    // unix + port triggers a warning
    const manifest = JSON.stringify({
      manifestVersion: 1,
      unix: '/tmp/test.sock',
      port: 3000,
    });
    const path = writeTempManifest(manifest);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path);
      const warnings = warnSpy.mock.calls.map(c => c[0]);
      expect(warnings.some((w: string) => typeof w === 'string' && w.includes('[createServerFromManifest]'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Entity handler/hook registration (lines 514-566)
// ---------------------------------------------------------------------------

describe('entity handler and hook registration into entity plugin', () => {
  it('bridges custom operation handlers from ManifestHandlerRegistry to entity plugin', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
            title: { type: 'string' },
          },
          operations: {
            publish: {
              kind: 'custom',
              handler: 'publishPost',
              method: 'POST',
              path: '/publish',
            },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    const publishFn = () => new Response('ok');
    registry.registerHandler('publishPost', () => publishFn);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
      expect(capturedEntityConfig).toBeDefined();
      const manifestRuntime = capturedEntityConfig!.manifestRuntime as Record<string, unknown>;
      expect(manifestRuntime).toBeDefined();
      expect(manifestRuntime.customHandlers).toBeDefined();
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('bridges afterAdapters hooks from ManifestHandlerRegistry to entity plugin', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
            title: { type: 'string' },
          },
        },
      },
      hooks: {
        afterAdapters: [{ handler: 'myHook' }],
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    const hookFn = async () => {};
    registry.registerHook('myHook', hookFn);

    let capturedEntityConfig: Record<string, unknown> | undefined;
    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => {
        if (config?.manifest) {
          capturedEntityConfig = config;
        }
        return makePlugin('mock-plugin');
      },
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
      expect(capturedEntityConfig).toBeDefined();
      const manifestRuntime = capturedEntityConfig!.manifestRuntime as Record<string, unknown>;
      expect(manifestRuntime).toBeDefined();
      expect(manifestRuntime.hooks).toBeDefined();
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips unregistered custom handlers gracefully', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
          },
          operations: {
            doSomething: {
              kind: 'custom',
              handler: 'notRegistered',
              method: 'POST',
              path: '/do',
            },
          },
        },
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    // Note: 'notRegistered' handler is NOT registered in the registry

    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => makePlugin('mock-plugin'),
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      // Should not throw even though handler is not registered
      await createServerFromManifest(path, registry);
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });

  it('skips unregistered afterAdapters hooks gracefully', async () => {
    const manifest = JSON.stringify({
      manifestVersion: 1,
      entities: {
        Post: {
          fields: {
            id: { type: 'string', primary: true },
          },
        },
      },
      hooks: {
        afterAdapters: [{ handler: 'nonexistentHook' }],
      },
    });
    const path = writeTempManifest(manifest);

    const registry = createManifestHandlerRegistry();
    // 'nonexistentHook' is NOT registered

    const loadSpy = spyOn(builtinPluginsModule, 'loadBuiltinPlugin').mockResolvedValue(
      (config?: Record<string, unknown>) => makePlugin('mock-plugin'),
    );
    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      await createServerFromManifest(path, registry);
    } finally {
      loadSpy.mockRestore();
      serverSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No-seed path — ensure seed is skipped when empty
// ---------------------------------------------------------------------------

describe('no-seed path', () => {
  it('does not run seed when seed section is absent', async () => {
    const path = writeTempManifest(
      JSON.stringify({
        manifestVersion: 1,
      }),
    );

    const serverSpy = spyOn(serverModule, 'createServer').mockResolvedValue(makeTestServer());

    try {
      const server = await createServerFromManifest(path);
      expect(server).toBeDefined();
    } finally {
      serverSpy.mockRestore();
    }
  });
});
