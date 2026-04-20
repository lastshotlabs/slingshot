/**
 * manifestToAppConfig — converts a validated AppManifest to a CreateServerConfig.
 *
 * Handles:
 *   - Direct field copies (60+ fields)
 *   - HandlerRef resolution (20 function-typed fields) via registry
 *   - Plugin instantiation via registry (including top-level built-in sections like `ssr`)
 *   - TLS key/cert/ca loading from file paths
 *   - Event bus resolution ('in-process' → InProcessAdapter; custom → registry)
 *   - WebSocket transport resolution ('in-memory' → default; redis → createRedisTransport)
 *   - Secret provider resolution (env/file/ssm built-ins; custom → registry)
 *   - Storage adapter construction (memory/local/s3)
 *   - ${importMetaDir} placeholder substitution in routesDir and workersDir
 *
 * NOTE: The following CreateAppConfig fields cannot yet be configured from manifest JSON
 * and are not handled by this converter:
 *   - ws.endpoints[].rateLimit, ws.endpoints[].recovery, ws.endpoints[].middleware
 *     (WS advanced features — planned)
 *   - ws.endpoints[].incoming — plugins self-wire incoming handlers during setupPost via
 *     SlingshotContext.wsEndpoints; static manifest wiring is not needed
 *   - security.csrf
 *   - logging/metrics.excludePaths RegExp entries (manifest accepts strings only)
 *   - upload.registryTtlSeconds
 */
import { localStorage } from '@framework/adapters/localStorage';
import type { LocalStorageConfig } from '@framework/adapters/localStorage';
import { memoryStorage } from '@framework/adapters/memoryStorage';
import { s3Storage } from '@framework/adapters/s3Storage';
import type { S3StorageConfig } from '@framework/adapters/s3Storage';
import {
  createEnvSecretRepository,
  createFileSecretRepository,
  createSsmSecretRepository,
} from '@framework/secrets';
import { createRedisTransport } from '@framework/ws/redisTransport';
import type { RedisTransportOptions } from '@framework/ws/redisTransport';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { KafkaConnectorHandle, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { CreateServerConfig } from '../server';
import type { AppManifest, AppManifestHandlerRef } from './manifest';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';
import { getManifestPluginRefs } from './manifestPluginRefs';
import {
  resolveLoggingStrategy,
  resolveNormalizePathStrategy,
  resolveRateLimitKeyStrategy,
  resolveRateLimitSkipStrategy,
  resolveUploadAuthStrategy,
  resolveValidationFormatStrategy,
} from './manifestStrategies';

export interface ManifestToConfigOptions {
  /**
   * Base directory for resolving ${importMetaDir} placeholders and relative paths.
   * Defaults to process.cwd(). createServerFromManifest sets this to the manifest's directory.
   */
  baseDir?: string;
  /**
   * Optional Kafka connector handle pre-resolved during manifest bootstrap.
   */
  kafkaConnectors?: KafkaConnectorHandle;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolvePath(value: string, baseDir: string): string {
  return resolve(value.replace('${importMetaDir}', baseDir));
}

function resolveRef(
  ref: AppManifestHandlerRef,
  registry: ManifestHandlerRegistry | undefined,
  context: string,
): unknown {
  if (!registry)
    throw new Error(
      `[manifestToAppConfig] HandlerRef "${ref.handler}" at ${context} requires a registry. ` +
        `Call registry.registerHandler("${ref.handler}", fn) before conversion.`,
    );
  return registry.resolveHandler(ref.handler, ref.params);
}

function resolveAuthField(
  auth: string | AppManifestHandlerRef[] | undefined,
  registry: ManifestHandlerRegistry | undefined,
  context: string,
): 'userAuth' | 'none' | unknown[] | undefined {
  if (!auth) return undefined;
  if (auth === 'userAuth' || auth === 'none') return auth;
  return (auth as AppManifestHandlerRef[]).map(ref => resolveRef(ref, registry, context));
}

function resolveTls(tls: AppManifest['tls']): CreateServerConfig['tls'] {
  if (!tls) return undefined;
  const { keyPath, certPath, caPath, ...rest } = tls as Record<string, unknown>;
  const result: CreateServerConfig['tls'] = {
    ...(rest as object),
    ...(keyPath ? { key: readFileSync(keyPath as string, 'utf-8') } : {}),
    ...(certPath ? { cert: readFileSync(certPath as string, 'utf-8') } : {}),
    ...(caPath ? { ca: readFileSync(caPath as string, 'utf-8') } : {}),
  };
  return result;
}

function resolvePlugins(
  refs: ReadonlyArray<{ plugin: string; config?: Record<string, unknown> }> | undefined,
  registry: ManifestHandlerRegistry | undefined,
): SlingshotPlugin[] {
  if (!refs?.length) return [];
  if (!registry)
    throw new Error(
      `[manifestToAppConfig] manifest.plugins requires a registry with registered plugin factories. ` +
        `Use createManifestHandlerRegistry() and call registry.registerPlugin() for each plugin, ` +
        `or use createServerFromManifest() which auto-registers built-in plugins.`,
    );
  return refs.map(ref => registry.resolvePlugin(ref.plugin, ref.config));
}

function resolveEventBus(
  spec: AppManifest['eventBus'],
  registry: ManifestHandlerRegistry | undefined,
): CreateServerConfig['eventBus'] {
  if (!spec) return undefined;
  if (spec === 'in-process') return createInProcessAdapter();
  if (spec === 'bullmq') {
    if (!registry)
      throw new Error(
        '[manifestToAppConfig] eventBus type "bullmq" requires a registry. ' +
          'Use createServerFromManifest() for built-in BullMQ auto-registration, ' +
          'or register it explicitly via registry.registerEventBus("bullmq", ...).',
      );
    return registry.resolveEventBus('bullmq');
  }
  if (spec === 'kafka') {
    if (!registry)
      throw new Error(
        '[manifestToAppConfig] eventBus type "kafka" requires a registry. ' +
          'Use createServerFromManifest() for built-in Kafka auto-registration, ' +
          'or register it explicitly via registry.registerEventBus("kafka", ...).',
      );
    return registry.resolveEventBus('kafka');
  }
  if (!registry)
    throw new Error(
      `[manifestToAppConfig] eventBus type "${(spec as { type: string }).type}" requires a registry.`,
    );

  const config =
    typeof spec === 'object'
      ? {
          ...((spec as { config?: Record<string, unknown> }).config ?? {}),
          ...('validation' in spec && spec.validation
            ? { validation: spec.validation }
            : {}),
        }
      : undefined;

  return registry.resolveEventBus(
    (spec as { type: string }).type,
    config,
  );
}

function resolveSecrets(
  spec: AppManifest['secrets'],
  registry: ManifestHandlerRegistry | undefined,
): CreateServerConfig['secrets'] {
  if (!spec) return undefined;
  const s = spec as {
    provider: string;
    prefix?: string;
    directory?: string;
    pathPrefix?: string;
    region?: string;
  };
  if (s.provider === 'env') return createEnvSecretRepository({ prefix: s.prefix });
  if (s.provider === 'file') return createFileSecretRepository({ directory: s.directory ?? '' });
  if (s.provider === 'ssm')
    return createSsmSecretRepository({
      pathPrefix: s.pathPrefix ?? '',
      region: s.region,
    });
  if (!registry)
    throw new Error(
      `[manifestToAppConfig] secrets.provider "${s.provider}" requires a registry.registerSecretProvider() entry.`,
    );
  return registry.resolveSecretProvider(s.provider, spec as Record<string, unknown>);
}

function resolveStorageAdapter(
  ref: NonNullable<AppManifest['upload']>['storage'],
): CreateServerConfig['upload'] extends { storage: infer S } | undefined ? S : never {
  const adapterRef = ref as { adapter: string; config?: Record<string, unknown> };
  if (adapterRef.adapter === 'memory') return memoryStorage() as never;
  if (adapterRef.adapter === 'local')
    return localStorage(adapterRef.config as unknown as LocalStorageConfig) as never;
  if (adapterRef.adapter === 's3')
    return s3Storage(adapterRef.config as unknown as S3StorageConfig) as never;
  throw new Error(`[manifestToAppConfig] Unknown storage adapter "${adapterRef.adapter}"`);
}

function resolveWsEndpoints(
  endpoints: NonNullable<AppManifest['ws']>['endpoints'],
  registry: ManifestHandlerRegistry | undefined,
): CreateServerConfig['ws'] extends { endpoints: infer E } | undefined ? E : never {
  const resolved: Record<string, unknown> = {};

  for (const [name, ep] of Object.entries(endpoints)) {
    const endpoint = ep as Record<string, unknown>;

    const resolvedOn: Record<string, unknown> = {};
    const on = endpoint['on'] as Record<string, AppManifestHandlerRef | undefined> | undefined;
    if (on) {
      if (on.open)
        resolvedOn.open = resolveRef(on.open, registry, `ws.endpoints["${name}"].on.open`);
      if (on.message)
        resolvedOn.message = resolveRef(on.message, registry, `ws.endpoints["${name}"].on.message`);
      if (on.close)
        resolvedOn.close = resolveRef(on.close, registry, `ws.endpoints["${name}"].on.close`);
      if (on.drain)
        resolvedOn.drain = resolveRef(on.drain, registry, `ws.endpoints["${name}"].on.drain`);
    }

    resolved[name] = {
      ...(endpoint['upgrade']
        ? {
            upgrade: resolveRef(
              endpoint['upgrade'] as AppManifestHandlerRef,
              registry,
              `ws.endpoints["${name}"].upgrade`,
            ),
          }
        : {}),
      ...(Object.keys(resolvedOn).length > 0 ? { on: resolvedOn } : {}),
      ...(endpoint['onRoomSubscribe']
        ? {
            onRoomSubscribe: resolveRef(
              endpoint['onRoomSubscribe'] as AppManifestHandlerRef,
              registry,
              `ws.endpoints["${name}"].onRoomSubscribe`,
            ),
          }
        : {}),
      ...(endpoint['maxMessageSize'] !== undefined
        ? { maxMessageSize: endpoint['maxMessageSize'] }
        : {}),
      ...(endpoint['heartbeat'] !== undefined ? { heartbeat: endpoint['heartbeat'] } : {}),
      ...(endpoint['presence'] !== undefined ? { presence: endpoint['presence'] } : {}),
      ...(endpoint['persistence'] !== undefined ? { persistence: endpoint['persistence'] } : {}),
    };
  }

  return resolved as never;
}

function resolveWsTransport(
  spec: NonNullable<AppManifest['ws']>['transport'] | undefined,
): NonNullable<CreateServerConfig['ws']>['transport'] | undefined {
  if (!spec || spec === 'in-memory') return undefined;

  const options = spec.options;
  if (!options || typeof options !== 'object') {
    throw new Error('[manifestToAppConfig] ws.transport.type "redis" requires an options object.');
  }
  if (!('connection' in options)) {
    throw new Error('[manifestToAppConfig] ws.transport.type "redis" requires options.connection.');
  }

  return createRedisTransport(options as unknown as RedisTransportOptions);
}

function resolveSseEndpoints(
  endpoints: NonNullable<AppManifest['sse']>['endpoints'],
  registry: ManifestHandlerRegistry | undefined,
): CreateServerConfig['sse'] extends { endpoints: infer E } | undefined ? E : never {
  const resolved: Record<string, unknown> = {};

  for (const [path, ep] of Object.entries(endpoints)) {
    const endpoint = ep as Record<string, unknown>;
    resolved[path] = {
      events: endpoint['events'],
      ...(endpoint['heartbeat'] !== undefined ? { heartbeat: endpoint['heartbeat'] } : {}),
      ...(endpoint['upgrade']
        ? {
            upgrade: resolveRef(
              endpoint['upgrade'] as AppManifestHandlerRef,
              registry,
              `sse.endpoints["${path}"].upgrade`,
            ),
          }
        : {}),
      ...(endpoint['filter']
        ? {
            filter: resolveRef(
              endpoint['filter'] as AppManifestHandlerRef,
              registry,
              `sse.endpoints["${path}"].filter`,
            ),
          }
        : {}),
    };
  }

  return resolved as never;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function manifestToAppConfig(
  manifest: AppManifest,
  registry?: ManifestHandlerRegistry,
  options?: ManifestToConfigOptions,
): CreateServerConfig {
  const baseDir = options?.baseDir ?? process.cwd();

  // Build config piece by piece. Sections with only plain fields are spread directly.
  // Sections with function-typed fields are built explicitly.
  const config: Record<string, unknown> = {};

  // -- routesDir (with placeholder substitution) --
  // Cast needed: Zod passthrough() intersection causes TypeScript to widen the field type
  if (manifest.routesDir !== undefined) {
    config.routesDir = resolvePath(manifest.routesDir, baseDir);
  }

  // -- Direct copy sections --
  if (manifest.meta !== undefined) config.meta = manifest.meta;
  if (manifest.db !== undefined) config.db = manifest.db;
  if (manifest.modelSchemas !== undefined) config.modelSchemas = manifest.modelSchemas;
  if (manifest.versioning !== undefined) config.versioning = manifest.versioning;
  if (manifest.port !== undefined) config.port = manifest.port;
  if (manifest.hostname !== undefined) config.hostname = manifest.hostname;
  if (manifest.unix !== undefined) config.unix = manifest.unix;
  if (manifest.enableWorkers !== undefined) config.enableWorkers = manifest.enableWorkers;
  if (manifest.maxRequestBodySize !== undefined)
    config.maxRequestBodySize = manifest.maxRequestBodySize;

  // -- workersDir (with placeholder substitution) --
  if (manifest.workersDir !== undefined)
    config.workersDir = resolvePath(manifest.workersDir, baseDir);

  // -- security --
  if (manifest.security !== undefined) {
    const sec = manifest.security as Record<string, unknown>;
    const rateLimit = sec['rateLimit'] as Record<string, unknown> | false | undefined;

    let resolvedRateLimit: Record<string, unknown> | false | undefined = undefined;
    if (rateLimit === false) {
      resolvedRateLimit = false;
    } else if (rateLimit) {
      const {
        keyGenerator,
        skip,
        handler: rlHandler,
        ...plainRl
      } = rateLimit as {
        keyGenerator?: string | AppManifestHandlerRef;
        skip?: string | AppManifestHandlerRef;
        handler?: AppManifestHandlerRef;
        [key: string]: unknown;
      };
      resolvedRateLimit = { ...plainRl };

      if (typeof keyGenerator === 'string') {
        resolvedRateLimit.keyGenerator = resolveRateLimitKeyStrategy(
          keyGenerator as 'ip' | 'user' | 'ip+user',
        );
      } else if (keyGenerator) {
        resolvedRateLimit.keyGenerator = resolveRef(
          keyGenerator,
          registry,
          'security.rateLimit.keyGenerator',
        );
      }

      if (typeof skip === 'string') {
        resolvedRateLimit.skip = resolveRateLimitSkipStrategy(skip as 'authenticated');
      } else if (skip) {
        resolvedRateLimit.skip = resolveRef(skip, registry, 'security.rateLimit.skip');
      }

      if (rlHandler) {
        resolvedRateLimit.handler = resolveRef(rlHandler, registry, 'security.rateLimit.handler');
      }
    }

    config.security = {
      ...sec,
      ...(resolvedRateLimit !== undefined ? { rateLimit: resolvedRateLimit } : {}),
    };
  }

  // -- middleware (array of HandlerRefs → functions) --
  if (manifest.middleware?.length) {
    config.middleware = manifest.middleware.map((ref, i) =>
      resolveRef(ref, registry, `middleware[${i}]`),
    );
  }

  // -- jobs --
  if (manifest.jobs !== undefined) {
    const { auth, ...plainJobs } = manifest.jobs as { auth?: unknown; [key: string]: unknown };
    config.jobs = {
      ...plainJobs,
      ...(auth !== undefined
        ? {
            auth: resolveAuthField(auth as string | AppManifestHandlerRef[], registry, 'jobs.auth'),
          }
        : {}),
    };
  }

  // -- tenancy --
  if (manifest.tenancy !== undefined) {
    const { onResolve, ...plainTenancy } = manifest.tenancy as {
      onResolve?: AppManifestHandlerRef;
      [key: string]: unknown;
    };
    config.tenancy = {
      ...plainTenancy,
      ...(onResolve ? { onResolve: resolveRef(onResolve, registry, 'tenancy.onResolve') } : {}),
    };
  }

  // -- logging --
  if (manifest.logging !== undefined) {
    const { onLog, ...plainLogging } = manifest.logging as {
      onLog?: string | AppManifestHandlerRef;
      [key: string]: unknown;
    };
    config.logging = {
      ...plainLogging,
      ...(typeof onLog === 'string'
        ? { onLog: resolveLoggingStrategy(onLog as 'json' | 'pretty') }
        : onLog
          ? { onLog: resolveRef(onLog, registry, 'logging.onLog') }
          : {}),
    };
  }

  // -- metrics --
  if (manifest.metrics !== undefined) {
    const {
      auth: metricsAuth,
      normalizePath,
      ...plainMetrics
    } = manifest.metrics as {
      auth?: unknown;
      normalizePath?: string | AppManifestHandlerRef;
      [key: string]: unknown;
    };
    config.metrics = {
      ...plainMetrics,
      ...(metricsAuth !== undefined
        ? {
            auth: resolveAuthField(
              metricsAuth as string | AppManifestHandlerRef[],
              registry,
              'metrics.auth',
            ),
          }
        : {}),
      ...(typeof normalizePath === 'string'
        ? { normalizePath: resolveNormalizePathStrategy(normalizePath as 'strip-ids') }
        : normalizePath
          ? { normalizePath: resolveRef(normalizePath, registry, 'metrics.normalizePath') }
          : {}),
    };
  }

  // -- validation --
  if (manifest.validation !== undefined) {
    const { formatError, ...plainValidation } = manifest.validation as {
      formatError?: string | AppManifestHandlerRef;
      [key: string]: unknown;
    };
    config.validation = {
      ...plainValidation,
      ...(typeof formatError === 'string'
        ? { formatError: resolveValidationFormatStrategy(formatError as 'flat' | 'grouped') }
        : formatError
          ? { formatError: resolveRef(formatError, registry, 'validation.formatError') }
          : {}),
    };
  }

  // -- upload --
  if (manifest.upload !== undefined) {
    const { storage, generateKey, authorization, ...plainUpload } = manifest.upload as {
      storage: NonNullable<AppManifest['upload']>['storage'];
      generateKey?: AppManifestHandlerRef;
      authorization?: {
        authorize?: string | AppManifestHandlerRef;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    const resolvedAuth = authorization
      ? {
          ...authorization,
          ...(typeof authorization.authorize === 'string'
            ? {
                authorize: resolveUploadAuthStrategy(
                  authorization.authorize as 'owner' | 'authenticated' | 'public',
                ),
              }
            : authorization.authorize
              ? {
                  authorize: resolveRef(
                    authorization.authorize,
                    registry,
                    'upload.authorization.authorize',
                  ),
                }
              : {}),
        }
      : undefined;

    config.upload = {
      ...plainUpload,
      storage: resolveStorageAdapter(storage),
      ...(generateKey
        ? { generateKey: resolveRef(generateKey, registry, 'upload.generateKey') }
        : {}),
      ...(resolvedAuth !== undefined ? { authorization: resolvedAuth } : {}),
    };
  }

  // -- TLS --
  if (manifest.tls !== undefined) config.tls = resolveTls(manifest.tls);

  // -- plugins --
  const resolvedPlugins = resolvePlugins(getManifestPluginRefs(manifest), registry);
  if (resolvedPlugins.length > 0) config.plugins = resolvedPlugins;

  // -- eventBus --
  const resolvedBus = resolveEventBus(manifest.eventBus, registry);
  if (resolvedBus !== undefined) config.eventBus = resolvedBus;

  if (options?.kafkaConnectors) {
    config.kafkaConnectors = options.kafkaConnectors;
  }

  // -- secrets --
  const resolvedSecrets = resolveSecrets(manifest.secrets, registry);
  if (resolvedSecrets !== undefined) config.secrets = resolvedSecrets;

  // -- ws --
  if (manifest.ws !== undefined) {
    const { endpoints, transport, ...plainWs } = manifest.ws as {
      endpoints: NonNullable<AppManifest['ws']>['endpoints'];
      transport?: NonNullable<AppManifest['ws']>['transport'];
      [key: string]: unknown;
    };
    const resolvedTransport = resolveWsTransport(transport);
    config.ws = {
      ...plainWs,
      endpoints: resolveWsEndpoints(endpoints, registry),
      ...(resolvedTransport !== undefined ? { transport: resolvedTransport } : {}),
    };
  }

  // -- sse --
  if (manifest.sse !== undefined) {
    const { endpoints, ...plainSse } = manifest.sse as {
      endpoints: NonNullable<AppManifest['sse']>['endpoints'];
      [key: string]: unknown;
    };
    config.sse = {
      ...plainSse,
      endpoints: resolveSseEndpoints(endpoints, registry),
    };
  }

  // -- observability --
  if (manifest.observability) {
    config.observability = {
      tracing: manifest.observability.tracing
        ? {
            enabled: manifest.observability.tracing.enabled,
            serviceName: manifest.observability.tracing.serviceName,
          }
        : undefined,
    };
  }

  // -- permissions -- plain data, no function refs
  if (manifest.permissions !== undefined) config.permissions = manifest.permissions;

  return config as unknown as CreateServerConfig;
}
