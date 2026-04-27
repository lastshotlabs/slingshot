/**
 * Zod validation tests for entityRouteConfigSchema and the cross-field
 * validation wired into entityConfigSchema.
 */
import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type { EntityRouteDataScopeConfig } from '@lastshotlabs/slingshot-core';
import { validateEntityRouteConfig } from '@lastshotlabs/slingshot-core';
import { defineEntity, field } from '../../src/defineEntity';
import {
  findScopedFieldInBody,
  normalizeDataScopes,
  resolveDataScopeValue,
  resolveDataScopes,
} from '../../src/routing/resolveDataScope';

// ---------------------------------------------------------------------------
// entityRouteConfigSchema validation
// ---------------------------------------------------------------------------

describe('validateEntityRouteConfig', () => {
  it('accepts a minimal valid config', () => {
    const result = validateEntityRouteConfig({
      create: { auth: 'userAuth' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full valid config', () => {
    const result = validateEntityRouteConfig({
      create: {
        auth: 'userAuth',
        permission: { requires: 'post:create', ownerField: 'authorId' },
        rateLimit: { windowMs: 60_000, max: 20 },
        event: { key: 'post:created', payload: ['title'] },
        middleware: ['audit'],
      },
      get: { auth: 'none' },
      list: { auth: 'userAuth' },
      update: { auth: 'userAuth', permission: { requires: 'post:update', or: 'post:admin' } },
      delete: { auth: 'userAuth' },
      defaults: { auth: 'userAuth' },
      disable: ['clear'],
      webhooks: { 'post:created': { payload: ['id', 'title'] } },
      retention: {
        hardDelete: { after: '90d', when: { status: 'deleted' } },
      },
      permissions: {
        resourceType: 'post',
        actions: ['create', 'read', 'update', 'delete'],
        roles: { editor: ['create', 'read', 'update'] },
      },
      middleware: { audit: true },
      cascades: [
        {
          event: 'user:deleted',
          batch: { action: 'delete', filter: { authorId: 'param:userId' } },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts event as a bare string', () => {
    const result = validateEntityRouteConfig({
      create: { event: 'post:created' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid auth value', () => {
    const result = validateEntityRouteConfig({ create: { auth: 'cookie' } });
    expect(result.success).toBe(false);
  });

  it('rejects rateLimit with non-integer windowMs', () => {
    const result = validateEntityRouteConfig({
      create: { rateLimit: { windowMs: 1.5, max: 10 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects rateLimit with negative max', () => {
    const result = validateEntityRouteConfig({
      create: { rateLimit: { windowMs: 60_000, max: -1 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid retention duration format', () => {
    const result = validateEntityRouteConfig({
      retention: { hardDelete: { after: '90days', when: {} } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid retention durations', () => {
    for (const dur of ['30s', '5m', '2h', '90d', '52w', '1y']) {
      const result = validateEntityRouteConfig({
        retention: { hardDelete: { after: dur, when: {} } },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects permissions with empty actions array', () => {
    const result = validateEntityRouteConfig({
      permissions: { resourceType: 'post', actions: [] },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-field validation via entityConfigSchema (via defineEntity)
// ---------------------------------------------------------------------------

const baseFields = {
  id: field.string({ primary: true, default: 'uuid' }),
  authorId: field.string(),
  title: field.string(),
  content: field.string({ optional: true }),
  status: field.enum(['draft', 'published', 'deleted'], { default: 'draft' }),
};

describe('entityConfigSchema routes cross-field validation', () => {
  it('accepts routes with valid ownerField references', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          update: {
            auth: 'userAuth',
            permission: { requires: 'post:update', ownerField: 'authorId' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts routes with valid dataScope references', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          defaults: { auth: 'userAuth' },
          dataScope: { field: 'authorId', from: 'ctx:actor.id' },
        },
      }),
    ).not.toThrow();
  });

  it('rejects routes with dataScope.field referencing a non-existent field', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          defaults: { auth: 'userAuth' },
          dataScope: { field: 'nonExistent', from: 'ctx:actor.id' },
        },
      }),
    ).toThrow(/routes\.dataScope\[0\]\.field.*does not exist/i);
  });

  it('rejects routes with ownerField referencing a non-existent field', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          update: {
            permission: { requires: 'post:update', ownerField: 'nonExistent' },
          },
        },
      }),
    ).toThrow(/nonExistent.*does not exist/i);
  });

  it('rejects routes.middleware name not declared in routes.middleware map', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          create: { middleware: ['audit'] },
          // 'audit' not in routes.middleware
        },
      }),
    ).toThrow(/audit.*not declared/i);
  });

  it('accepts routes.middleware name declared in routes.middleware map', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          create: { middleware: ['audit'] },
          middleware: { audit: true },
        },
      }),
    ).not.toThrow();
  });

  it('rejects event.payload field referencing non-existent entity field', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          create: {
            event: { key: 'post:created', payload: ['title', 'nonExistentField'] },
          },
        },
      }),
    ).toThrow(/nonExistentField.*does not exist/i);
  });

  it('accepts event.payload with valid field references', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          create: {
            event: { key: 'post:created', payload: ['title', 'authorId'] },
          },
        },
      }),
    ).not.toThrow();
  });

  it('rejects routes.disable with unknown operation name', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          disable: ['nonExistentOp'],
        },
      }),
    ).toThrow(/not a valid CRUD or operation name/i);
  });

  it('accepts routes.disable with valid CRUD operation names', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          disable: ['delete', 'clear'],
        },
      }),
    ).not.toThrow();
  });

  it('accepts routes.disable with a declared custom operation name', () => {
    expect(() =>
      defineEntity('Post', {
        fields: baseFields,
        routes: {
          operations: {
            publish: { auth: 'userAuth' },
          },
          disable: ['publish'],
        },
      }),
    ).not.toThrow();
  });

  it('omitting routes produces the same entity as before', () => {
    const without = defineEntity('Post', { fields: baseFields });
    const withRoutes = defineEntity('Post', { fields: baseFields, routes: undefined });
    expect(without._pkField).toBe(withRoutes._pkField);
    expect(without._storageName).toBe(withRoutes._storageName);
  });
});

// ---------------------------------------------------------------------------
// resolveDataScope helpers
// ---------------------------------------------------------------------------

describe('resolveDataScope helpers', () => {
  function createContext(values: Record<string, unknown>, params: Record<string, string>): Context {
    return {
      get: (key: string) => values[key],
      req: {
        param: (key: string) => params[key] ?? '',
      },
    } as unknown as Context;
  }

  it('normalizes single and array scopes', () => {
    const single = normalizeDataScopes({ field: 'authorId', from: 'ctx:actor.id' });
    const many = normalizeDataScopes([
      { field: 'authorId', from: 'ctx:actor.id' },
      { field: 'orgId', from: 'param:orgId', applyTo: ['list'] },
    ]);
    expect(single).toHaveLength(1);
    expect(many).toHaveLength(2);
  });

  it('resolves ctx and param sources', () => {
    const c = createContext(
      {
        actor: {
          id: 'user-1',
          kind: 'user',
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        },
      },
      { orgId: 'org-2' },
    );
    expect(resolveDataScopeValue('ctx:actor.id', c)).toBe('user-1');
    expect(resolveDataScopeValue('param:orgId', c)).toBe('org-2');
  });

  it('preserves empty-string tenant context for ctx:tenantId', () => {
    const c = createContext({ tenantId: '' }, {});
    expect(resolveDataScopeValue('ctx:tenantId', c)).toBe('');
  });

  it('returns missing when a scope source is absent', () => {
    const c = createContext({}, {});
    const result = resolveDataScopes([{ field: 'authorId', from: 'ctx:actor.id' }], 'get', c);
    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.source).toBe('ctx:actor.id');
    }
  });

  it('builds bindings and respects applyTo', () => {
    const c = createContext(
      {
        actor: {
          id: 'user-1',
          kind: 'user',
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        },
      },
      { orgId: 'org-2' },
    );
    const scopes: readonly EntityRouteDataScopeConfig[] = [
      { field: 'authorId', from: 'ctx:actor.id' },
      { field: 'orgId', from: 'param:orgId', applyTo: ['list', 'get'] as const },
    ];
    const list = resolveDataScopes(scopes, 'list', c);
    expect(list.status).toBe('ok');
    if (list.status === 'ok') {
      expect(list.bindings).toEqual({ authorId: 'user-1', orgId: 'org-2' });
    }
    const create = resolveDataScopes(scopes, 'create', c);
    expect(create.status).toBe('ok');
    if (create.status === 'ok') {
      expect(create.bindings).toEqual({ authorId: 'user-1' });
    }
  });

  it('finds the first scoped field present in the body', () => {
    const scopes: readonly EntityRouteDataScopeConfig[] = [
      { field: 'authorId', from: 'ctx:actor.id' },
      { field: 'orgId', from: 'param:orgId' },
    ];
    expect(findScopedFieldInBody(scopes, { authorId: 'user-2' })).toBe('authorId');
    expect(findScopedFieldInBody(scopes, { title: 'hello' })).toBeNull();
  });
});
