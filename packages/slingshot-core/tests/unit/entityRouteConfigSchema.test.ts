import { describe, expect, test } from 'bun:test';
import { resolveOpConfig } from '../../src/entityRouteConfig';
import {
  entityRouteConfigSchema,
  validateEntityRouteConfig,
} from '../../src/entityRouteConfigSchema';

// ---------------------------------------------------------------------------
// Valid route config parses successfully
// ---------------------------------------------------------------------------

describe('entityRouteConfigSchema — valid configs', () => {
  test('empty config is valid', () => {
    expect(entityRouteConfigSchema.safeParse({}).success).toBe(true);
  });

  test('full CRUD operation config parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { auth: 'userAuth' },
      get: { auth: 'userAuth' },
      list: { auth: 'userAuth' },
      update: { auth: 'userAuth', permission: { requires: 'posts.update' } },
      delete: { auth: 'userAuth', permission: { requires: 'posts.delete' } },
      defaults: { auth: 'userAuth' },
      disable: ['clear'],
      middleware: { requireAdmin: true },
    });
    expect(result.success).toBe(true);
  });

  test('named operations parse', () => {
    const result = entityRouteConfigSchema.safeParse({
      operations: {
        publish: { auth: 'userAuth', rateLimit: { windowMs: 60000, max: 10 } },
        archive: { auth: 'bearer', method: 'post', path: 'archive-now' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operations?.archive.path).toBe('archive-now');
      expect(result.data.operations?.archive.method).toBe('post');
    }
  });

  test('event as string shorthand parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { event: 'entity:posts.created' },
    });
    expect(result.success).toBe(true);
  });

  test('event as object parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: {
        event: {
          key: 'entity:posts.created',
          payload: ['id', 'title'],
          include: ['tenantId', 'actorId'],
          exposure: ['client-safe'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('retention config with positive duration parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      retention: { hardDelete: { after: '90d', when: { status: 'deleted' } } },
    });
    expect(result.success).toBe(true);
  });

  test('permissions config parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      permissions: {
        resourceType: 'posts',
        actions: ['create', 'read', 'update', 'delete'],
        roles: { admin: ['*'], user: ['read'] },
      },
    });
    expect(result.success).toBe(true);
  });

  test('dataScope config parses with ctx and param sources', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth' },
      dataScope: [
        { field: 'userId', from: 'ctx:authUserId' },
        { field: 'orgId', from: 'param:orgId', applyTo: ['list', 'get'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('idempotency config parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      defaults: { auth: 'userAuth', idempotency: true },
      update: { idempotency: { ttl: 3600, scope: 'user' } },
      operations: {
        publish: { auth: 'userAuth', idempotency: { scope: 'tenant' } },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forbidden event prefix rejected
// ---------------------------------------------------------------------------

describe('entityRouteConfigSchema — forbidden event prefixes', () => {
  const FORBIDDEN = [
    'security.auth.login',
    'auth:login',
    'community:delivery.email',
    'push:notification',
    'app:ready',
  ];

  for (const key of FORBIDDEN) {
    test(`rejects forbidden event key "${key}" as string shorthand`, () => {
      const result = entityRouteConfigSchema.safeParse({
        create: { event: key },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join(' ');
        expect(messages).toContain('forbidden namespace');
      }
    });

    test(`rejects forbidden event key "${key}" in object form`, () => {
      const result = entityRouteConfigSchema.safeParse({
        create: { event: { key } },
      });
      expect(result.success).toBe(false);
    });
  }

  test('event exposure with allowed key parses', () => {
    const result = entityRouteConfigSchema.safeParse({
      update: {
        event: {
          key: 'entity:posts.updated',
          exposure: ['client-safe'],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid duration rejected (including 0d)
// ---------------------------------------------------------------------------

describe('entityRouteConfigSchema — duration validation', () => {
  const INVALID_DURATIONS = [
    '0d',
    '0s',
    '0m',
    '0h',
    '0w',
    '0y',
    '00d',
    'abc',
    '1',
    'd',
    '-1d',
    '1.5d',
  ];

  for (const dur of INVALID_DURATIONS) {
    test(`rejects invalid duration "${dur}"`, () => {
      const result = entityRouteConfigSchema.safeParse({
        retention: { hardDelete: { after: dur, when: {} } },
      });
      expect(result.success).toBe(false);
    });
  }

  const VALID_DURATIONS = ['1d', '30d', '90d', '1y', '12m', '24h', '1s', '1w'];

  for (const dur of VALID_DURATIONS) {
    test(`accepts valid duration "${dur}"`, () => {
      const result = entityRouteConfigSchema.safeParse({
        retention: { hardDelete: { after: dur, when: {} } },
      });
      expect(result.success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Missing required fields caught
// ---------------------------------------------------------------------------

describe('entityRouteConfigSchema — required field validation', () => {
  test('rateLimit missing windowMs is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { rateLimit: { max: 10 } },
    });
    expect(result.success).toBe(false);
  });

  test('rateLimit missing max is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { rateLimit: { windowMs: 60000 } },
    });
    expect(result.success).toBe(false);
  });

  test('permission missing requires is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { permission: { ownerField: 'userId' } },
    });
    expect(result.success).toBe(false);
  });

  test('permissions missing resourceType is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      permissions: { actions: ['read'] },
    });
    expect(result.success).toBe(false);
  });

  test('permissions missing actions is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      permissions: { resourceType: 'posts' },
    });
    expect(result.success).toBe(false);
  });

  test('empty string event key is rejected', () => {
    const result = entityRouteConfigSchema.safeParse({
      create: { event: '' },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateEntityRouteConfig helper
// ---------------------------------------------------------------------------

describe('validateEntityRouteConfig', () => {
  test('returns success: true for valid config', () => {
    const result = validateEntityRouteConfig({ create: { auth: 'userAuth' } });
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test('rejects dataScope without auth', () => {
    const result = validateEntityRouteConfig({
      dataScope: { field: 'userId', from: 'ctx:authUserId' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors?.issues[0]?.message).toContain('requires auth');
    }
  });

  test('returns success: false with errors for invalid config', () => {
    const result = validateEntityRouteConfig({
      create: { rateLimit: { max: 'not-a-number' } },
    });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  test('rejects user-scoped idempotency without auth', () => {
    const result = validateEntityRouteConfig({
      create: { idempotency: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors?.issues[0]?.message).toContain("idempotency.scope 'user' requires auth");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOpConfig — merge logic
// ---------------------------------------------------------------------------

describe('resolveOpConfig — merge logic', () => {
  test('per-op config overrides defaults', () => {
    const config = {
      defaults: { auth: 'none' as const },
      create: { auth: 'userAuth' as const },
    };
    const resolved = resolveOpConfig(config, 'create');
    expect(resolved?.auth).toBe('userAuth');
  });

  test('defaults apply when no per-op config', () => {
    const config = {
      defaults: { auth: 'userAuth' as const, rateLimit: { windowMs: 60000, max: 10 } },
    };
    const resolved = resolveOpConfig(config, 'list');
    expect(resolved?.auth).toBe('userAuth');
    expect(resolved?.rateLimit).toEqual({ windowMs: 60000, max: 10 });
  });

  test('partial per-op override keeps defaults for unspecified fields', () => {
    const config = {
      defaults: { auth: 'userAuth' as const, rateLimit: { windowMs: 60000, max: 10 } },
      create: { auth: 'none' as const },
    };
    const resolved = resolveOpConfig(config, 'create');
    expect(resolved?.auth).toBe('none');
    // rateLimit from defaults is preserved
    expect(resolved?.rateLimit).toEqual({ windowMs: 60000, max: 10 });
  });

  test('defaults-only idempotency resolves for other operations', () => {
    const config = {
      defaults: { auth: 'userAuth' as const, idempotency: true },
    };
    const resolved = resolveOpConfig(config, 'update');
    expect(resolved?.idempotency).toBe(true);
  });

  test('named operation in operations map is resolved', () => {
    const config = {
      defaults: { auth: 'userAuth' as const },
      operations: { publish: { auth: 'bearer' as const } },
    };
    const resolved = resolveOpConfig(config, 'publish');
    expect(resolved?.auth).toBe('bearer');
  });

  test('returns undefined when no config and no meaningful defaults', () => {
    const config = {};
    const resolved = resolveOpConfig(config, 'create');
    expect(resolved).toBeUndefined();
  });
});
