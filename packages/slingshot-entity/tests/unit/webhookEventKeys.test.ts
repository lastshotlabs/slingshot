/**
 * Tests: webhook event key collection via applyRouteConfig().
 */
import { describe, expect, it, mock } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { applyRouteConfig } from '../../src/routing/applyRouteConfig';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';
import type { BareEntityAdapter } from '../../src/routing/buildBareEntityRoutes';

function asResolvedConfig(config: Record<string, unknown>): ResolvedEntityConfig {
  return {
    _systemFields: {
      createdBy: 'createdBy',
      updatedBy: 'updatedBy',
      ownerField: 'ownerId',
      tenantField: 'tenantId',
      version: 'version',
    },
    _storageFields: {
      mongoPkField: '_id',
      ttlField: '_expires_at',
      mongoTtlField: '_expiresAt',
    },
    _conventions: {},
    ...config,
  } as unknown as ResolvedEntityConfig;
}

const entityConfig = asResolvedConfig({
  name: 'Message',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    body: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'messages',
});

function makeAdapter(): BareEntityAdapter {
  return {
    create: mock((d: unknown) => Promise.resolve(d)),
    getById: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve({ items: [], hasMore: false })),
    update: mock((_id: string, d: unknown) => Promise.resolve(d)),
    delete: mock(() => Promise.resolve(true)),
  };
}

describe('webhook event key collection', () => {
  it('collects all webhook event keys via applyRouteConfig', () => {
    const router = buildBareEntityRoutes(entityConfig, undefined, makeAdapter());
    const webhookEventKeys: string[] = [];

    applyRouteConfig(
      router,
      entityConfig,
      {
        webhooks: {
          'message:created': { payload: ['id', 'body'] },
          'message:deleted': {},
        },
      },
      { webhookEventKeys },
    );

    expect(webhookEventKeys).toContain('message:created');
    expect(webhookEventKeys).toContain('message:deleted');
    expect(webhookEventKeys).toHaveLength(2);
  });

  it('does not duplicate keys from multiple calls', () => {
    const webhookEventKeys: string[] = [];
    const adapter = makeAdapter();

    const router1 = buildBareEntityRoutes(entityConfig, undefined, adapter);
    applyRouteConfig(
      router1,
      entityConfig,
      { webhooks: { 'a:created': {} } },
      {
        webhookEventKeys,
      },
    );

    const router2 = buildBareEntityRoutes(entityConfig, undefined, adapter);
    applyRouteConfig(
      router2,
      entityConfig,
      { webhooks: { 'b:created': {} } },
      {
        webhookEventKeys,
      },
    );

    expect(webhookEventKeys).toContain('a:created');
    expect(webhookEventKeys).toContain('b:created');
    expect(webhookEventKeys).toHaveLength(2);
  });

  it('is a no-op when webhookEventKeys not provided', () => {
    const router = buildBareEntityRoutes(entityConfig, undefined, makeAdapter());
    expect(() =>
      applyRouteConfig(
        router,
        entityConfig,
        { webhooks: { 'x:event': {} } },
        {}, // no webhookEventKeys
      ),
    ).not.toThrow();
  });

  it('is a no-op when no webhooks config', () => {
    const router = buildBareEntityRoutes(entityConfig, undefined, makeAdapter());
    const webhookEventKeys: string[] = [];

    applyRouteConfig(router, entityConfig, { create: {} }, { webhookEventKeys });

    expect(webhookEventKeys).toHaveLength(0);
  });
});
