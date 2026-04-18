import type { Context } from 'hono';
import { resolve } from 'path';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type { AppManifestHandlerRef } from './manifest';
import { createDeferredAdminProviders } from './manifestAdminProviders';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';

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
        bun: { pkg: '@lastshotlabs/runtime-bun', factory: 'bunRuntime' },
        node: { pkg: '@lastshotlabs/runtime-node', factory: 'nodeRuntime' },
        edge: { pkg: '@lastshotlabs/runtime-edge', factory: 'edgeRuntime' },
      };
      const entry = pkgMap[strategy];
      let resolved: unknown = null;
      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (!resolved) {
              // Synchronous require — runtime packages are expected to be installed
              // eslint-disable-next-line @typescript-eslint/no-require-imports
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
          const rolesValue = c.get('roles');
          const roles = Array.isArray(rolesValue)
            ? rolesValue.filter((role): role is string => typeof role === 'string')
            : [];
          return Promise.resolve(roles.includes('super-admin'));
        },
      };
    case 'authenticated':
      return {
        verifyRequest(c: Context<AppEnv>): Promise<boolean> {
          return Promise.resolve(c.get('authUserId') != null);
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
