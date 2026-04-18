/**
 * Tests for resolveOpConfig() — defaults merge logic.
 */
import { describe, expect, it } from 'bun:test';
import { resolveOpConfig } from '@lastshotlabs/slingshot-core';
import type { EntityRouteConfig } from '@lastshotlabs/slingshot-core';

describe('resolveOpConfig', () => {
  it('returns undefined when no config and no defaults', () => {
    const rc: EntityRouteConfig = {};
    expect(resolveOpConfig(rc, 'create')).toBeUndefined();
  });

  it('returns undefined when defaults are empty and op has no config', () => {
    const rc: EntityRouteConfig = { defaults: {} };
    expect(resolveOpConfig(rc, 'get')).toBeUndefined();
  });

  it('returns defaults when op has no specific config', () => {
    const rc: EntityRouteConfig = {
      defaults: { auth: 'userAuth', rateLimit: { windowMs: 60_000, max: 10 } },
    };
    const resolved = resolveOpConfig(rc, 'list');
    expect(resolved?.auth).toBe('userAuth');
    expect(resolved?.rateLimit?.max).toBe(10);
  });

  it('specific CRUD op config wins over defaults', () => {
    const rc: EntityRouteConfig = {
      defaults: { auth: 'userAuth' },
      get: { auth: 'none' },
    };
    const resolved = resolveOpConfig(rc, 'get');
    expect(resolved?.auth).toBe('none');
  });

  it('merges defaults with specific config (specific wins per key)', () => {
    const rc: EntityRouteConfig = {
      defaults: {
        auth: 'userAuth',
        rateLimit: { windowMs: 60_000, max: 10 },
      },
      create: {
        rateLimit: { windowMs: 30_000, max: 5 },
        event: 'post:created',
      },
    };
    const resolved = resolveOpConfig(rc, 'create');
    // defaults.auth is preserved
    expect(resolved?.auth).toBe('userAuth');
    // create.rateLimit wins
    expect(resolved?.rateLimit?.windowMs).toBe(30_000);
    expect(resolved?.rateLimit?.max).toBe(5);
    // create.event is added
    expect(resolved?.event).toBe('post:created');
  });

  it('resolves named operations from operations map', () => {
    const rc: EntityRouteConfig = {
      defaults: { auth: 'userAuth' },
      operations: {
        publish: { permission: { requires: 'post:publish' } },
      },
    };
    const resolved = resolveOpConfig(rc, 'publish');
    expect(resolved?.auth).toBe('userAuth');
    expect(resolved?.permission?.requires).toBe('post:publish');
  });

  it('returns undefined for operation not in config and no defaults with values', () => {
    const rc: EntityRouteConfig = {
      operations: { publish: { auth: 'none' } },
    };
    // 'archive' is not in operations
    expect(resolveOpConfig(rc, 'archive')).toBeUndefined();
  });

  it('CRUD op config takes precedence over operations map for the same name', () => {
    // If both rc.create and rc.operations.create exist (unusual but testing precedence)
    const rc: EntityRouteConfig = {
      create: { auth: 'bearer' },
      operations: { create: { auth: 'none' } },
    };
    // crud wins over operations map
    const resolved = resolveOpConfig(rc, 'create');
    expect(resolved?.auth).toBe('bearer');
  });

  it('permission is merged from defaults if op has none', () => {
    const rc: EntityRouteConfig = {
      defaults: { permission: { requires: 'entity:read' } },
      list: { auth: 'userAuth' },
    };
    const resolved = resolveOpConfig(rc, 'list');
    expect(resolved?.permission?.requires).toBe('entity:read');
    expect(resolved?.auth).toBe('userAuth');
  });

  it('op-specific permission overrides defaults permission', () => {
    const rc: EntityRouteConfig = {
      defaults: { permission: { requires: 'entity:read' } },
      delete: { permission: { requires: 'entity:delete' } },
    };
    const resolved = resolveOpConfig(rc, 'delete');
    expect(resolved?.permission?.requires).toBe('entity:delete');
  });
});
