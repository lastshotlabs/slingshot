import { mock } from 'bun:test';
import type {
  AppEnv,
  EntityRegistry,
  OperationConfig,
  ResolvedEntityConfig,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import type { BareEntityAdapter } from '../../src/routing/buildBareEntityRoutes';

export function createMockAdapter(): BareEntityAdapter {
  return {
    create: mock((data: unknown) => Promise.resolve({ id: '1', ...(data as object) })),
    getById: mock((id: string) => Promise.resolve({ id })),
    list: mock(() => Promise.resolve({ items: [], hasMore: false })),
    update: mock((id: string, data: unknown) => Promise.resolve({ id, ...(data as object) })),
    delete: mock(() => Promise.resolve(true)),
  };
}

export function createMockBus(): SlingshotEventBus & {
  subscriptions: Array<{
    event: string;
    handler: (payload: Record<string, unknown>) => void | Promise<void>;
  }>;
} {
  const subscriptions: Array<{
    event: string;
    handler: (payload: Record<string, unknown>) => void | Promise<void>;
  }> = [];

  return {
    emit: mock(() => {}) as unknown as SlingshotEventBus['emit'],
    on: mock(
      (event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>) => {
        subscriptions.push({ event, handler });
      },
    ),
    off: mock(
      (event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>) => {
        const index = subscriptions.findIndex(s => s.event === event && s.handler === handler);
        if (index !== -1) subscriptions.splice(index, 1);
      },
    ),
    subscriptions,
  };
}

export function createMockFrameworkConfig(): SlingshotFrameworkConfig & {
  entityRegistry: EntityRegistry & { registered: ResolvedEntityConfig[] };
} {
  const registered: ResolvedEntityConfig[] = [];

  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false,
    password: Bun.password,
    storeInfra: createMemoryStoreInfra(),
    registrar: {} as unknown as import('@lastshotlabs/slingshot-core').CoreRegistrar,
    entityRegistry: {
      registered,
      register: mock((config: ResolvedEntityConfig) => {
        registered.push(config);
      }),
      get: mock(() => undefined),
      list: mock(() => registered),
    } as unknown as EntityRegistry & { registered: ResolvedEntityConfig[] },
  };
}

type MockApp = import('hono').Hono<AppEnv> & {
  route: ReturnType<typeof mock>;
  use: ReturnType<typeof mock>;
  routes: Array<{ path: string; router: unknown }>;
};

export function createMockApp(order?: string[]): MockApp {
  const routes: Array<{ path: string; router: unknown }> = [];

  return {
    route: mock((path: string, router: unknown) => {
      order?.push('route');
      routes.push({ path, router });
    }),
    use: mock(() => {}),
    routes,
  } as unknown as MockApp;
}

export function createMockInfraWithFactory(
  resolver: (
    config: ResolvedEntityConfig,
    operations?: Record<string, OperationConfig>,
  ) => Record<string, unknown>,
): StoreInfra {
  const infra: StoreInfra = {} as unknown as StoreInfra;
  Reflect.set(
    infra as object,
    RESOLVE_ENTITY_FACTORIES,
    (config: ResolvedEntityConfig, operations?: Record<string, OperationConfig>) => ({
      memory: () => resolver(config, operations),
      redis: () => resolver(config, operations),
      sqlite: () => resolver(config, operations),
      postgres: () => resolver(config, operations),
      mongo: () => resolver(config, operations),
    }),
  );
  return infra;
}

export function createMockInfraWithCompositeFactory(
  resolver: () => Record<string, unknown>,
): StoreInfra {
  const infra: StoreInfra = {} as unknown as StoreInfra;
  const factories = {
    memory: () => resolver(),
    redis: () => resolver(),
    sqlite: () => resolver(),
    postgres: () => resolver(),
    mongo: () => resolver(),
  };

  Reflect.set(infra as object, RESOLVE_ENTITY_FACTORIES, () => factories);
  Reflect.set(infra as object, RESOLVE_COMPOSITE_FACTORIES, () => factories);

  return infra;
}
