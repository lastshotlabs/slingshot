import { createRequire } from 'node:module';
import type { Context, MiddlewareHandler } from 'hono';
import { resolve } from 'path';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor, getActorId } from '@lastshotlabs/slingshot-core';
import type { AppManifestHandlerRef } from './manifest';
import { createDeferredAdminProviders } from './manifestAdminProviders';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';

const require = createRequire(import.meta.url);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isHandlerRefLike(value: unknown): value is AppManifestHandlerRef {
  if (!isRecord(value) || typeof value['handler'] !== 'string') return false;
  const params = value['params'];
  return params === undefined || isRecord(params);
}

export function requireRegistry(registry: ManifestHandlerRegistry | undefined, context: string) {
  if (!registry) {
    throw new Error(
      `[manifest builtin config] ${context} requires a manifest handler registry. ` +
        'Register the referenced handlers before resolving manifest config.',
    );
  }

  return registry;
}

export function resolveHandlerRef(
  value: AppManifestHandlerRef,
  registry: ManifestHandlerRegistry | undefined,
  context: string,
): unknown {
  return requireRegistry(registry, context).resolveHandler(value.handler, value.params);
}

export function resolveBuiltinPath(value: string, baseDir: string): string {
  return resolve(baseDir, value.replace('${importMetaDir}', baseDir));
}

function resolveSsrRuntimeStrategy(strategy: string): unknown {
  switch (strategy) {
    case 'bun':
    case 'node':
    case 'edge': {
      // Lazy runtime resolution — returns a proxy that loads the runtime package on first use.
      // The real runtime is created when the SSR plugin accesses it during setup.
      const pkgMap: Record<string, { pkg: string; factory: string }> = {
        bun: { pkg: '@lastshotlabs/slingshot-runtime-bun', factory: 'bunRuntime' },
        node: { pkg: '@lastshotlabs/slingshot-runtime-node', factory: 'nodeRuntime' },
        edge: { pkg: '@lastshotlabs/slingshot-runtime-edge', factory: 'edgeRuntime' },
      };
      const entry = pkgMap[strategy];
      let resolved: unknown = null;
      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (!resolved) {
              // Synchronous require — runtime packages are expected to be installed
              const mod = require(entry.pkg) as Record<string, unknown>;
              const factory = mod[entry.factory] as () => unknown;
              resolved = factory();
            }
            return (resolved as Record<string | symbol, unknown>)[prop];
          },
        },
      );
    }
    default:
      throw new Error(
        `[resolveSsrManifestConfig] Unknown runtime strategy "${strategy}". ` +
          'Use "bun", "node", "edge", or a handler reference.',
      );
  }
}

function resolveIsrAdapterStrategy(strategy: string): unknown {
  switch (strategy) {
    case 'memory': {
      const cache = new Map<string, unknown>();
      return {
        get(path: string) {
          return Promise.resolve(cache.get(path) ?? null);
        },
        set(path: string, entry: unknown) {
          cache.set(path, entry);
          return Promise.resolve();
        },
        invalidatePath(path: string) {
          cache.delete(path);
          return Promise.resolve();
        },
        invalidateTag(tag: string) {
          for (const [key, value] of cache) {
            const rawTags =
              typeof value === 'object' && value !== null
                ? (value as Record<string, unknown>)['tags']
                : undefined;
            if (Array.isArray(rawTags) && rawTags.includes(tag)) {
              cache.delete(key);
            }
          }
          return Promise.resolve();
        },
      };
    }
    default:
      throw new Error(
        `[resolveSsrManifestConfig] Unknown ISR adapter strategy "${strategy}". ` +
          'Use "memory" or a handler reference.',
      );
  }
}

export function resolveSsrManifestConfig(
  config: Record<string, unknown>,
  registry: ManifestHandlerRegistry | undefined,
  baseDir: string,
  contextPrefix: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...config };

  if (isHandlerRefLike(config['renderer'])) {
    resolved['renderer'] = resolveHandlerRef(
      config['renderer'],
      registry,
      `${contextPrefix}.renderer`,
    );
  }

  if (typeof config['runtime'] === 'string' && !isHandlerRefLike(config['runtime'])) {
    resolved['runtime'] = resolveSsrRuntimeStrategy(config['runtime']);
  } else if (isHandlerRefLike(config['runtime'])) {
    resolved['runtime'] = resolveHandlerRef(
      config['runtime'],
      registry,
      `${contextPrefix}.runtime`,
    );
  }

  if (typeof config['serverRoutesDir'] === 'string') {
    resolved['serverRoutesDir'] = resolveBuiltinPath(config['serverRoutesDir'], baseDir);
  }

  if (typeof config['serverActionsDir'] === 'string') {
    resolved['serverActionsDir'] = resolveBuiltinPath(config['serverActionsDir'], baseDir);
  }

  if (typeof config['staticDir'] === 'string') {
    resolved['staticDir'] = resolveBuiltinPath(config['staticDir'], baseDir);
  }

  if (typeof config['assetsManifest'] === 'string') {
    const assetsManifest = config['assetsManifest'].trimStart();
    resolved['assetsManifest'] = assetsManifest.startsWith('{')
      ? config['assetsManifest']
      : resolveBuiltinPath(config['assetsManifest'], baseDir);
  }

  const isr = config['isr'];
  if (isRecord(isr)) {
    if (typeof isr['adapter'] === 'string' && !isHandlerRefLike(isr['adapter'])) {
      resolved['isr'] = {
        ...isr,
        adapter: resolveIsrAdapterStrategy(isr['adapter']),
      };
    } else if (isHandlerRefLike(isr['adapter'])) {
      resolved['isr'] = {
        ...isr,
        adapter: resolveHandlerRef(isr['adapter'], registry, `${contextPrefix}.isr.adapter`),
      };
    }
  }

  return resolved;
}

export function resolveWebhookManifestConfig(
  config: Record<string, unknown>,
  registry: ManifestHandlerRegistry | undefined,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...config };

  if (isHandlerRefLike(config['adapter'])) {
    resolved['adapter'] = resolveHandlerRef(
      config['adapter'],
      registry,
      'manifest.plugins["slingshot-webhooks"].config.adapter',
    );
  }

  if (isHandlerRefLike(config['queue'])) {
    resolved['queue'] = resolveHandlerRef(
      config['queue'],
      registry,
      'manifest.plugins["slingshot-webhooks"].config.queue',
    );
  }

  if (isHandlerRefLike(config['adminGuard'])) {
    resolved['adminGuard'] = resolveHandlerRef(
      config['adminGuard'],
      registry,
      'manifest.plugins["slingshot-webhooks"].config.adminGuard',
    );
  }

  if (Array.isArray(config['inbound'])) {
    resolved['inbound'] = (config['inbound'] as unknown[]).map((provider, index) =>
      isHandlerRefLike(provider)
        ? resolveHandlerRef(
            provider,
            registry,
            `manifest.plugins["slingshot-webhooks"].config.inbound[${index}]`,
          )
        : provider,
    );
  }

  const queueConfig = config['queueConfig'];
  if (isRecord(queueConfig) && isHandlerRefLike(queueConfig['onDeadLetter'])) {
    resolved['queueConfig'] = {
      ...queueConfig,
      onDeadLetter: resolveHandlerRef(
        queueConfig['onDeadLetter'],
        registry,
        'manifest.plugins["slingshot-webhooks"].config.queueConfig.onDeadLetter',
      ),
    };
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Search plugin — tenant resolution and admin gate strategies
// ---------------------------------------------------------------------------

/**
 * Resolve built-in strategy strings in search plugin manifest config to runtime values.
 *
 * - `tenantResolution: "framework"` → `tenantResolver: c => c.get('tenantId')`
 * - `adminGate: "superAdmin" | "authenticated"` → `SearchAdminGate` object
 *
 * @param config - Raw search plugin config from the manifest.
 * @returns Resolved config with function-typed fields populated.
 */
function resolveTemporalTlsConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const tls = config['tls'];
  if (!isRecord(tls)) return undefined;
  const resolved: Record<string, unknown> = {};
  if (typeof tls['serverNameOverride'] === 'string') {
    resolved['serverNameOverride'] = tls['serverNameOverride'];
  }
  if (typeof tls['serverRootCACertificate'] === 'string') {
    resolved['serverRootCACertificate'] = tls['serverRootCACertificate'];
  }
  if (isRecord(tls['clientCertPair'])) {
    resolved['clientCertPair'] = {
      crt: tls['clientCertPair']['crt'],
      key: tls['clientCertPair']['key'],
    };
  }
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

export function resolveOrchestrationManifestConfig(
  config: Record<string, unknown>,
  registry: ManifestHandlerRegistry | undefined,
): Record<string, unknown> {
  const requiredRegistry = requireRegistry(
    registry,
    'manifest.plugins["slingshot-orchestration"]',
  );
  const adapterRef = isRecord(config['adapter']) ? config['adapter'] : {};
  const adapterType = typeof adapterRef['type'] === 'string' ? adapterRef['type'] : 'memory';
  const adapterConfig = isRecord(adapterRef['config']) ? adapterRef['config'] : {};
  const taskNames = Array.isArray(config['tasks']) ? config['tasks'] : [];
  const workflowNames = Array.isArray(config['workflows']) ? config['workflows'] : [];

  const tasks = taskNames.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(
        `[manifest builtin config] manifest.plugins["slingshot-orchestration"].config.tasks[${index}] must be a string.`,
      );
    }
    return requiredRegistry.resolveTask(value);
  });
  const workflows = workflowNames.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(
        `[manifest builtin config] manifest.plugins["slingshot-orchestration"].config.workflows[${index}] must be a string.`,
      );
    }
    return requiredRegistry.resolveWorkflow(value);
  });

  const routeMiddleware = Array.isArray(config['routeMiddleware'])
    ? (config['routeMiddleware'] as unknown[]).map((value, index) => {
        if (!isHandlerRefLike(value)) {
          throw new Error(
            `[manifest builtin config] manifest.plugins["slingshot-orchestration"].config.routeMiddleware[${index}] must be a handler reference.`,
          );
        }
        return resolveHandlerRef(
          value,
          requiredRegistry,
          `manifest.plugins["slingshot-orchestration"].config.routeMiddleware[${index}]`,
        ) as MiddlewareHandler;
      })
    : undefined;

  let adapter: unknown;
  if (adapterType === 'memory') {
    const { createMemoryAdapter } = require(
      '@lastshotlabs/slingshot-orchestration',
    ) as typeof import('@lastshotlabs/slingshot-orchestration');
    adapter = createMemoryAdapter(adapterConfig as { concurrency?: number });
  } else if (adapterType === 'sqlite') {
    const { createSqliteAdapter } = require(
      '@lastshotlabs/slingshot-orchestration',
    ) as typeof import('@lastshotlabs/slingshot-orchestration');
    adapter = createSqliteAdapter(adapterConfig as { path: string; concurrency?: number });
  } else if (adapterType === 'bullmq') {
    const { createBullMQOrchestrationAdapter } = require(
      '@lastshotlabs/slingshot-orchestration-bullmq',
    ) as typeof import('@lastshotlabs/slingshot-orchestration-bullmq');
    adapter = createBullMQOrchestrationAdapter(adapterConfig as never);
  } else if (adapterType === 'temporal') {
    const temporalConfig = adapterConfig;
    const { Connection, Client } = require('@temporalio/client') as typeof import('@temporalio/client');
    const { createTemporalOrchestrationAdapter } = require(
      '@lastshotlabs/slingshot-orchestration-temporal',
    ) as typeof import('@lastshotlabs/slingshot-orchestration-temporal');
    const namespace =
      typeof temporalConfig['namespace'] === 'string' ? temporalConfig['namespace'] : undefined;
    const tls = resolveTemporalTlsConfig(temporalConfig);
    const connection = Connection.lazy({
      address:
        typeof temporalConfig['address'] === 'string'
          ? temporalConfig['address']
          : 'localhost:7233',
      ...(tls ? { tls: tls as never } : {}),
    });
    const client = new Client({
      connection,
      ...(namespace ? { namespace } : {}),
    });
    adapter = createTemporalOrchestrationAdapter({
      client,
      connection,
      namespace,
      workflowTaskQueue: String(temporalConfig['workflowTaskQueue']),
      ...(typeof temporalConfig['defaultActivityTaskQueue'] === 'string'
        ? { defaultActivityTaskQueue: temporalConfig['defaultActivityTaskQueue'] }
        : {}),
      ownsConnection: true,
    });
  } else {
    throw new Error(
      `[manifest builtin config] Unsupported orchestration adapter type "${adapterType}".`,
    );
  }

  return {
    adapter,
    tasks,
    workflows,
    ...(config['routes'] === undefined ? {} : { routes: config['routes'] }),
    ...(typeof config['routePrefix'] === 'string' ? { routePrefix: config['routePrefix'] } : {}),
    ...(routeMiddleware ? { routeMiddleware } : {}),
  };
}

export function resolveSearchManifestConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...config };

  if (config['tenantResolution'] === 'framework' && !config['tenantResolver']) {
    resolved['tenantResolver'] = (c: Context<AppEnv>) =>
      (c.get('tenantId') as string | undefined) ?? undefined;
    delete resolved['tenantResolution'];
  }

  if (typeof config['adminGate'] === 'string') {
    resolved['adminGate'] = resolveSearchAdminGateStrategy(config['adminGate']);
  }

  return resolved;
}

function resolveSearchAdminGateStrategy(strategy: string): {
  verifyRequest(c: Context<AppEnv>): Promise<boolean>;
} {
  switch (strategy) {
    case 'superAdmin':
      return {
        verifyRequest(c: Context<AppEnv>): Promise<boolean> {
          const rolesValue = getActor(c).roles;
          const roles = Array.isArray(rolesValue)
            ? rolesValue.filter((role): role is string => typeof role === 'string')
            : [];
          return Promise.resolve(roles.includes('super-admin'));
        },
      };
    case 'authenticated':
      return {
        verifyRequest(c: Context<AppEnv>): Promise<boolean> {
          return Promise.resolve(getActorId(c) != null);
        },
      };
    default:
      throw new Error(
        `[resolveSearchManifestConfig] Unknown adminGate strategy "${strategy}". ` +
          'Use "superAdmin", "authenticated", or a SearchAdminGate object.',
      );
  }
}

// ---------------------------------------------------------------------------
// Admin plugin — auto-wiring to auth and permissions plugins
// ---------------------------------------------------------------------------

/**
 * Resolve string strategies in admin plugin manifest config to deferred provider proxies.
 *
 * When config fields are strings like `"slingshot-auth"` or `"slingshot-permissions"`, creates
 * deferred providers that resolve from plugin state during setup. Returns the resolved config
 * plus a `bind` function and dependency list for the factory wrapper to use.
 *
 * @param config - Raw admin plugin config from the manifest.
 * @returns `{ config, bind, deps }` — resolved config, binding function, and dependencies.
 */
export function resolveAdminManifestConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  bind: ((pluginState: Map<string, unknown>) => void) | null;
  deps: string[];
} {
  const hasStringStrategies =
    config['accessProvider'] === 'slingshot-auth' ||
    config['managedUserProvider'] === 'slingshot-auth' ||
    config['permissions'] === 'slingshot-permissions' ||
    config['auditLog'] === 'memory';

  if (!hasStringStrategies) {
    return { config, bind: null, deps: [] };
  }

  // Dynamic import to avoid circular dependency — manifestAdminProviders imports from slingshot-core/auth
  const deferred = createDeferredAdminProviders(config);
  const resolved: Record<string, unknown> = { ...config };

  if (deferred.accessProvider) resolved['accessProvider'] = deferred.accessProvider;
  if (deferred.managedUserProvider) resolved['managedUserProvider'] = deferred.managedUserProvider;
  if (deferred.permissions) resolved['permissions'] = deferred.permissions;
  if (deferred.auditLog) resolved['auditLog'] = deferred.auditLog;

  return { config: resolved, bind: deferred.bind, deps: deferred.deps };
}
