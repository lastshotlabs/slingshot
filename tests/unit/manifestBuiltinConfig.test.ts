import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SlingshotRuntime } from '@lastshotlabs/slingshot-core';

type ManifestBuiltinConfigModule = typeof import('../../src/lib/manifestBuiltinConfig');

function makeRuntimeStub(serveLabel: string, supportsAsyncLocalStorage = true): SlingshotRuntime & {
  serve: () => string;
} {
  return {
    password: {
      hash: (plain: string) => Bun.password.hash(plain),
      verify: (plain: string, hash: string) => Bun.password.verify(plain, hash),
    },
    sqlite: {
      open: () => ({
        run: () => {},
        query: () => ({
          get: () => null,
          all: () => [],
          run: () => {},
        }),
        prepare: () => ({
          get: () => null,
          all: () => [],
          run: () => ({ changes: 0 }),
        }),
        transaction: fn => fn,
        close: () => {},
      }),
    },
    server: {
      listen: () => ({
        port: 3000,
        stop: () => {},
        upgrade: () => false,
        publish: () => {},
      }),
    },
    fs: {
      write: async () => {},
      readFile: async () => null,
      exists: async () => false,
    },
    glob: {
      scan: async () => [],
    },
    readFile: async () => null,
    supportsAsyncLocalStorage,
    serve: () => serveLabel,
  };
}

async function loadManifestBuiltinConfig(): Promise<ManifestBuiltinConfigModule> {
  mock.module('@lastshotlabs/slingshot-runtime-bun', () => ({
    bunRuntime: () => makeRuntimeStub('bun-serve'),
  }));
  mock.module('@lastshotlabs/slingshot-runtime-node', () => ({
    nodeRuntime: () => makeRuntimeStub('node-serve'),
  }));
  mock.module('@lastshotlabs/slingshot-runtime-edge', () => ({
    edgeRuntime: () => makeRuntimeStub('edge-serve', false),
  }));

  return import(
    `../../src/lib/manifestBuiltinConfig.ts?manifestBuiltinConfig=${Date.now()}-${Math.random()}`
  );
}

let isRecord: ManifestBuiltinConfigModule['isRecord'];
let isHandlerRefLike: ManifestBuiltinConfigModule['isHandlerRefLike'];
let requireRegistry: ManifestBuiltinConfigModule['requireRegistry'];
let resolveHandlerRef: ManifestBuiltinConfigModule['resolveHandlerRef'];
let resolveBuiltinPath: ManifestBuiltinConfigModule['resolveBuiltinPath'];
let resolveAdminManifestConfig: ManifestBuiltinConfigModule['resolveAdminManifestConfig'];
let resolveSearchManifestConfig: ManifestBuiltinConfigModule['resolveSearchManifestConfig'];
let resolveSsrManifestConfig: ManifestBuiltinConfigModule['resolveSsrManifestConfig'];
let resolveWebhookManifestConfig: ManifestBuiltinConfigModule['resolveWebhookManifestConfig'];

beforeEach(async () => {
  mock.restore();
  ({
    isRecord,
    isHandlerRefLike,
    requireRegistry,
    resolveHandlerRef,
    resolveBuiltinPath,
    resolveAdminManifestConfig,
    resolveSearchManifestConfig,
    resolveSsrManifestConfig,
    resolveWebhookManifestConfig,
  } = await loadManifestBuiltinConfig());
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe('isHandlerRefLike', () => {
  it('returns true for { handler: string }', () => {
    expect(isHandlerRefLike({ handler: 'myHandler' })).toBe(true);
  });

  it('returns true for { handler: string, params: {} }', () => {
    expect(isHandlerRefLike({ handler: 'myHandler', params: { key: 'val' } })).toBe(true);
  });

  it('returns false for non-object', () => {
    expect(isHandlerRefLike('string')).toBe(false);
    expect(isHandlerRefLike(null)).toBe(false);
  });

  it('returns false when handler is not a string', () => {
    expect(isHandlerRefLike({ handler: 42 })).toBe(false);
  });

  it('returns false when params is not an object', () => {
    expect(isHandlerRefLike({ handler: 'h', params: 'bad' })).toBe(false);
  });
});

describe('requireRegistry', () => {
  it('throws when registry is undefined', () => {
    expect(() => requireRegistry(undefined, 'test')).toThrow(/requires a manifest handler registry/);
  });

  it('returns registry when defined', () => {
    const reg = { resolveHandler: () => {} } as any;
    expect(requireRegistry(reg, 'test')).toBe(reg);
  });
});

describe('resolveHandlerRef', () => {
  it('calls registry.resolveHandler with handler and params', () => {
    let calledWith: unknown[];
    const reg = {
      resolveHandler(...args: unknown[]) {
        calledWith = args;
        return 'resolved';
      },
    } as any;
    const result = resolveHandlerRef({ handler: 'myFn', params: { x: 1 } }, reg, 'ctx');
    expect(result).toBe('resolved');
    expect(calledWith!).toEqual(['myFn', { x: 1 }]);
  });

  it('throws when registry is undefined', () => {
    expect(() => resolveHandlerRef({ handler: 'fn' } as any, undefined, 'ctx')).toThrow();
  });
});

describe('resolveBuiltinPath', () => {
  it('resolves ${importMetaDir} relative to baseDir', () => {
    const result = resolveBuiltinPath('${importMetaDir}/views', '/app');
    expect(result).toContain('views');
  });

  it('resolves plain relative path', () => {
    const result = resolveBuiltinPath('./public', '/app');
    expect(result).toContain('public');
  });
});

// ---------------------------------------------------------------------------
// Search plugin strategies
// ---------------------------------------------------------------------------

describe('resolveSearchManifestConfig', () => {
  it('resolves tenantResolution: "framework" to a tenantResolver function', () => {
    const result = resolveSearchManifestConfig({
      tenantResolution: 'framework',
      tenantField: 'orgId',
    });

    expect(typeof result['tenantResolver']).toBe('function');
    expect(result['tenantResolution']).toBeUndefined();
    expect(result['tenantField']).toBe('orgId');
  });

  it('tenantResolver from "framework" reads tenantId from context', () => {
    const result = resolveSearchManifestConfig({ tenantResolution: 'framework' });
    const resolver = result['tenantResolver'] as (c: unknown) => string | undefined;

    const c = { get: (key: string) => (key === 'tenantId' ? 'tenant_abc' : undefined) };
    expect(resolver(c)).toBe('tenant_abc');
  });

  it('tenantResolver returns undefined when context has no tenantId', () => {
    const result = resolveSearchManifestConfig({ tenantResolution: 'framework' });
    const resolver = result['tenantResolver'] as (c: unknown) => string | undefined;

    const c = { get: () => undefined };
    expect(resolver(c)).toBeUndefined();
  });

  it('does not override existing tenantResolver', () => {
    const custom = () => 'custom';
    const result = resolveSearchManifestConfig({
      tenantResolution: 'framework',
      tenantResolver: custom,
    });
    expect(result['tenantResolver']).toBe(custom);
  });

  it('resolves adminGate: "superAdmin" to a gate that checks super-admin role', async () => {
    const result = resolveSearchManifestConfig({ adminGate: 'superAdmin' });
    const gate = result['adminGate'] as { verifyRequest(c: unknown): Promise<boolean> };

    const adminCtx = { get: (k: string) => (k === 'roles' ? ['super-admin'] : null) };
    const userCtx = { get: (k: string) => (k === 'roles' ? ['member'] : null) };
    const anonCtx = { get: () => null };

    expect(await gate.verifyRequest(adminCtx)).toBe(true);
    expect(await gate.verifyRequest(userCtx)).toBe(false);
    expect(await gate.verifyRequest(anonCtx)).toBe(false);
  });

  it('resolves adminGate: "authenticated" to a gate that checks authUserId', async () => {
    const result = resolveSearchManifestConfig({ adminGate: 'authenticated' });
    const gate = result['adminGate'] as { verifyRequest(c: unknown): Promise<boolean> };

    const authCtx = { get: (k: string) => (k === 'authUserId' ? 'usr_1' : null) };
    const anonCtx = { get: () => null };

    expect(await gate.verifyRequest(authCtx)).toBe(true);
    expect(await gate.verifyRequest(anonCtx)).toBe(false);
  });

  it('throws for unknown adminGate strategy', () => {
    expect(() => resolveSearchManifestConfig({ adminGate: 'invalid' })).toThrow(
      /Unknown adminGate strategy/,
    );
  });

  it('passes through non-strategy fields unchanged', () => {
    const result = resolveSearchManifestConfig({
      mountPath: '/search',
      indexPrefix: 'test_',
    });
    expect(result['mountPath']).toBe('/search');
    expect(result['indexPrefix']).toBe('test_');
  });
});

// ---------------------------------------------------------------------------
// Admin plugin auto-wiring
// ---------------------------------------------------------------------------

describe('resolveAdminManifestConfig', () => {
  it('returns config unchanged when no string strategies are present', () => {
    const original = { mountPath: '/admin', accessProvider: { name: 'custom' } };
    const result = resolveAdminManifestConfig(original);

    expect(result.config).toBe(original);
    expect(result.bind).toBeNull();
    expect(result.deps).toEqual([]);
  });

  it('adds slingshot-auth to deps when accessProvider is "slingshot-auth"', () => {
    const result = resolveAdminManifestConfig({ accessProvider: 'slingshot-auth' });

    expect(result.deps).toContain('slingshot-auth');
    expect(result.bind).not.toBeNull();
    expect(typeof result.config['accessProvider']).toBe('object');
  });

  it('adds slingshot-auth to deps when managedUserProvider is "slingshot-auth"', () => {
    const result = resolveAdminManifestConfig({ managedUserProvider: 'slingshot-auth' });

    expect(result.deps).toContain('slingshot-auth');
    expect(result.bind).not.toBeNull();
    expect(typeof result.config['managedUserProvider']).toBe('object');
  });

  it('adds slingshot-permissions to deps when permissions is "slingshot-permissions"', () => {
    const result = resolveAdminManifestConfig({ permissions: 'slingshot-permissions' });

    expect(result.deps).toContain('slingshot-permissions');
    expect(result.bind).not.toBeNull();
    expect(typeof result.config['permissions']).toBe('object');
  });

  it('resolves auditLog: "memory" to an in-memory audit log', async () => {
    const result = resolveAdminManifestConfig({ auditLog: 'memory' });
    const auditLog = result.config['auditLog'] as {
      logEntry(entry: unknown): Promise<void>;
      getLogs(query: unknown): Promise<{ items: unknown[] }>;
    };

    expect(typeof auditLog.logEntry).toBe('function');
    expect(typeof auditLog.getLogs).toBe('function');

    await auditLog.logEntry({
      userId: 'u1',
      action: 'test',
      path: '/admin/test',
      method: 'POST',
    });
    const logs = await auditLog.getLogs({});
    expect(logs.items).toHaveLength(1);
  });

  it('deduplicates slingshot-auth in deps', () => {
    const result = resolveAdminManifestConfig({
      accessProvider: 'slingshot-auth',
      managedUserProvider: 'slingshot-auth',
    });

    const authCount = result.deps.filter(d => d === 'slingshot-auth').length;
    expect(authCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SSR runtime + ISR adapter strategies
// ---------------------------------------------------------------------------

describe('resolveSsrManifestConfig', () => {
  it('resolves ISR adapter: "memory" to an in-memory cache', async () => {
    const result = resolveSsrManifestConfig(
      { isr: { adapter: 'memory' } },
      undefined,
      '/tmp',
      'ssr',
    );

    const isr = result['isr'] as Record<string, unknown>;
    const adapter = isr['adapter'] as {
      get(path: string): Promise<unknown>;
      set(path: string, entry: unknown): Promise<void>;
      invalidatePath(path: string): Promise<void>;
      invalidateTag(tag: string): Promise<void>;
    };

    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');

    await adapter.set('/page', { html: '<h1>hi</h1>', tags: ['tag1'] });
    expect(await adapter.get('/page')).toEqual({ html: '<h1>hi</h1>', tags: ['tag1'] });

    await adapter.invalidatePath('/page');
    expect(await adapter.get('/page')).toBeNull();
  });

  it('ISR memory adapter supports tag-based invalidation', async () => {
    const result = resolveSsrManifestConfig(
      { isr: { adapter: 'memory' } },
      undefined,
      '/tmp',
      'ssr',
    );
    const adapter = (result['isr'] as Record<string, unknown>)['adapter'] as {
      get(path: string): Promise<unknown>;
      set(path: string, entry: unknown): Promise<void>;
      invalidateTag(tag: string): Promise<void>;
    };

    await adapter.set('/a', { html: 'a', tags: ['blog'] });
    await adapter.set('/b', { html: 'b', tags: ['blog', 'featured'] });
    await adapter.set('/c', { html: 'c', tags: ['other'] });

    await adapter.invalidateTag('blog');

    expect(await adapter.get('/a')).toBeNull();
    expect(await adapter.get('/b')).toBeNull();
    expect(await adapter.get('/c')).not.toBeNull();
  });

  it('throws for unknown runtime strategy', () => {
    expect(() =>
      resolveSsrManifestConfig({ runtime: 'invalid' }, undefined, '/tmp', 'ssr'),
    ).toThrow(/Unknown runtime strategy/);
  });

  it('throws for unknown ISR adapter strategy', () => {
    expect(() =>
      resolveSsrManifestConfig({ isr: { adapter: 'invalid' } }, undefined, '/tmp', 'ssr'),
    ).toThrow(/Unknown ISR adapter strategy/);
  });

  it('passes through non-strategy fields unchanged', () => {
    const result = resolveSsrManifestConfig({ staticDir: './public' }, undefined, '/base', 'ssr');
    // staticDir is resolved as a path relative to baseDir
    expect(typeof result['staticDir']).toBe('string');
  });

  it('resolves renderer handler ref', () => {
    const reg = { resolveHandler: () => ({ render: () => {} }) } as any;
    const result = resolveSsrManifestConfig(
      { renderer: { handler: 'myRenderer' } },
      reg,
      '/base',
      'ssr',
    );
    expect(typeof result['renderer']).toBe('object');
  });

  it('resolves runtime handler ref', () => {
    const reg = { resolveHandler: () => ({ serve: () => {} }) } as any;
    const result = resolveSsrManifestConfig(
      { runtime: { handler: 'myRuntime' } },
      reg,
      '/base',
      'ssr',
    );
    expect(typeof result['runtime']).toBe('object');
  });

  it('resolves serverRoutesDir path', () => {
    const result = resolveSsrManifestConfig(
      { serverRoutesDir: './routes' },
      undefined,
      '/base',
      'ssr',
    );
    expect(typeof result['serverRoutesDir']).toBe('string');
    expect(result['serverRoutesDir']).toContain('routes');
  });

  it('resolves serverActionsDir path', () => {
    const result = resolveSsrManifestConfig(
      { serverActionsDir: './actions' },
      undefined,
      '/base',
      'ssr',
    );
    expect(typeof result['serverActionsDir']).toBe('string');
  });

  it('resolves assetsManifest path', () => {
    const result = resolveSsrManifestConfig(
      { assetsManifest: './dist/manifest.json' },
      undefined,
      '/base',
      'ssr',
    );
    expect(typeof result['assetsManifest']).toBe('string');
  });

  it('keeps inline JSON assetsManifest as-is', () => {
    const json = '{"main.js": "/assets/main.abc.js"}';
    const result = resolveSsrManifestConfig(
      { assetsManifest: json },
      undefined,
      '/base',
      'ssr',
    );
    expect(result['assetsManifest']).toBe(json);
  });

  it('resolves ISR adapter handler ref', () => {
    const reg = { resolveHandler: () => ({ get: () => {} }) } as any;
    const result = resolveSsrManifestConfig(
      { isr: { adapter: { handler: 'myAdapter' } } },
      reg,
      '/base',
      'ssr',
    );
    const isr = result['isr'] as Record<string, unknown>;
    expect(typeof isr['adapter']).toBe('object');
  });

  it('resolves runtime: "bun" to a lazy proxy that loads on first access (lines 46-72)', () => {
    const result = resolveSsrManifestConfig(
      { runtime: 'bun' },
      undefined,
      '/base',
      'ssr',
    );
    const runtime = result['runtime'] as Record<string, unknown>;
    // Access a property to trigger the proxy getter (lines 61-68)
    expect(typeof runtime.serve).toBe('function');
  });

  it('resolves runtime: "node" to a lazy proxy that loads on first access', () => {
    const result = resolveSsrManifestConfig(
      { runtime: 'node' },
      undefined,
      '/base',
      'ssr',
    );
    const runtime = result['runtime'] as Record<string, unknown>;
    expect(typeof runtime.serve).toBe('function');
  });

  it('resolves runtime: "edge" to a lazy proxy that loads on first access', () => {
    const result = resolveSsrManifestConfig(
      { runtime: 'edge' },
      undefined,
      '/base',
      'ssr',
    );
    const runtime = result['runtime'] as Record<string, unknown>;
    expect(typeof runtime.serve).toBe('function');
  });

  it('proxy caches the resolved runtime on subsequent accesses', () => {
    const result = resolveSsrManifestConfig(
      { runtime: 'bun' },
      undefined,
      '/base',
      'ssr',
    );
    const runtime = result['runtime'] as Record<string, unknown>;
    // First access triggers require + factory
    const serve1 = runtime.serve;
    // Second access should reuse cached resolved object
    const serve2 = runtime.serve;
    expect(serve1).toBe(serve2);
  });
});

// ---------------------------------------------------------------------------
// Webhook plugin config
// ---------------------------------------------------------------------------

describe('resolveWebhookManifestConfig', () => {
  it('passes through config unchanged when no handler refs present', () => {
    const config = { retryCount: 3, maxPayloadSize: 1024 };
    const result = resolveWebhookManifestConfig(config, undefined);
    expect(result['retryCount']).toBe(3);
  });

  it('resolves adapter handler ref', () => {
    const reg = { resolveHandler: () => ({ send: () => {} }) } as any;
    const result = resolveWebhookManifestConfig(
      { adapter: { handler: 'webhookAdapter' } },
      reg,
    );
    expect(typeof result['adapter']).toBe('object');
  });

  it('resolves queue handler ref', () => {
    const reg = { resolveHandler: () => ({ enqueue: () => {} }) } as any;
    const result = resolveWebhookManifestConfig(
      { queue: { handler: 'webhookQueue' } },
      reg,
    );
    expect(typeof result['queue']).toBe('object');
  });

  it('resolves adminGuard handler ref', () => {
    const reg = { resolveHandler: () => ({ check: () => {} }) } as any;
    const result = resolveWebhookManifestConfig(
      { adminGuard: { handler: 'myGuard' } },
      reg,
    );
    expect(typeof result['adminGuard']).toBe('object');
  });

  it('resolves inbound provider handler refs', () => {
    const reg = { resolveHandler: () => ({ verify: () => {} }) } as any;
    const result = resolveWebhookManifestConfig(
      { inbound: [{ handler: 'provider1' }, 'plainProvider'] },
      reg,
    );
    const inbound = result['inbound'] as unknown[];
    expect(typeof inbound[0]).toBe('object');
    expect(inbound[1]).toBe('plainProvider');
  });

  it('resolves queueConfig.onDeadLetter handler ref', () => {
    const reg = { resolveHandler: () => (() => {}) } as any;
    const result = resolveWebhookManifestConfig(
      { queueConfig: { maxRetries: 3, onDeadLetter: { handler: 'dlqHandler' } } },
      reg,
    );
    const qc = result['queueConfig'] as Record<string, unknown>;
    expect(typeof qc['onDeadLetter']).toBe('function');
    expect(qc['maxRetries']).toBe(3);
  });
});
