import { describe, expect, it } from 'bun:test';
import {
  resolveAdminManifestConfig,
  resolveSearchManifestConfig,
  resolveSsrManifestConfig,
} from '../../src/lib/manifestBuiltinConfig';

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
});
