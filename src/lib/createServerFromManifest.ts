import { resolveSecretBundle } from '@framework/secrets';
import { getRedisConnectionOptions } from '@lib/redis';
import type { Server } from 'bun';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { SUPER_ADMIN_ROLE, getPermissionsStateOrNull } from '@lastshotlabs/slingshot-core';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { createServer, getServerContext } from '../server';
import { createBuiltinPluginFactory, loadBuiltinPlugin } from './builtinPlugins';
import { validateAppManifest } from './manifest';
import type { AppManifest } from './manifest';
import { createManifestHandlerRegistry } from './manifestHandlerRegistry';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';
import { getManifestPluginRefs } from './manifestPluginRefs';
import { manifestToAppConfig } from './manifestToAppConfig';
import type { ManifestToConfigOptions } from './manifestToAppConfig';

export interface CreateServerFromManifestOptions extends ManifestToConfigOptions {
  /**
   * Validate and convert the manifest without starting the server.
   * Returns a stub. Used by tests and the CLI's dry-run mode.
   */
  dryRun?: boolean;

  /**
   * Override the handler file path. When set, this takes precedence over the
   * manifest's `handlers` field. Used by the CLI's `--handlers` flag.
   *
   * - `string` — path to a single handlers file (absolute or relative to baseDir)
   * - `{ dir: string }` — directory of handler files
   * - `false` — disable handler auto-loading
   * - `undefined` — use the manifest's `handlers` field (default behavior)
   */
  handlersPath?: string | { dir: string } | false;
}

/**
 * Import a single module file and register its exports into the registry.
 *
 * For each named export:
 * - If the name is `'hooks'` and the value is an object, each function-valued property
 *   is registered as a lifecycle hook via `registry.registerHook()`.
 * - If the value is a function, it is registered as a named handler via
 *   `registry.registerHandler()`.
 * - Other exports are silently ignored.
 */
async function registerModuleExports(
  registry: ManifestHandlerRegistry,
  filePath: string,
): Promise<void> {
  const mod = (await import(filePath)) as Record<string, unknown>;

  for (const [name, value] of Object.entries(mod)) {
    if (name === 'hooks' && typeof value === 'object' && value !== null) {
      for (const [hookName, hookFn] of Object.entries(value as Record<string, unknown>)) {
        if (typeof hookFn === 'function') {
          registry.registerHook(hookName, hookFn as (ctx: unknown) => void | Promise<void>);
        }
      }
    } else if (typeof value === 'function') {
      const fn = value;
      registry.registerHandler(name, () => fn);
    }
  }
}

/**
 * Load handler exports from a file or directory and register them into the given registry.
 *
 * Supports three configuration modes:
 * - **String** — path to a single handlers file, resolved relative to `baseDir`.
 * - **`{ dir: string }`** — directory of handler files. All `.ts` and `.js` files in the
 *   directory (non-recursive, excluding `.d.ts`) are imported and their exports registered.
 * - **`false`** — explicitly disables handler auto-loading.
 *
 * When `handlersConfig` is `undefined`, defaults to `"slingshot.handlers.ts"` resolved
 * relative to `baseDir` (the manifest file's directory).
 *
 * @param registry - The manifest handler registry to populate.
 * @param handlersConfig - The resolved `handlers` manifest field value, or undefined for default.
 * @param baseDir - Base directory for resolving relative paths (manifest file's directory).
 */
async function loadHandlersIntoRegistry(
  registry: ManifestHandlerRegistry,
  handlersConfig: string | { dir: string } | false | undefined,
  baseDir: string,
): Promise<void> {
  if (handlersConfig === false) return;

  if (typeof handlersConfig === 'object' && 'dir' in handlersConfig) {
    const dirPath = resolve(baseDir, handlersConfig.dir);
    if (!existsSync(dirPath)) return;

    const files = readdirSync(dirPath)
      .filter(f => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
      .sort();

    for (const file of files) {
      await registerModuleExports(registry, resolve(dirPath, file));
    }
    return;
  }

  const filePath = resolve(
    baseDir,
    typeof handlersConfig === 'string' ? handlersConfig : 'slingshot.handlers.ts',
  );

  if (!existsSync(filePath)) return;
  await registerModuleExports(registry, filePath);
}

function addSyntheticManifestPlugins(manifest: AppManifest): AppManifest {
  const plugins = [...(manifest.plugins ?? [])];
  const hasEntityPlugin = plugins.some(ref => ref.plugin === 'slingshot-entity');
  const hasPermissionsPlugin = plugins.some(ref => ref.plugin === 'slingshot-permissions');

  const nextPlugins = [...plugins];

  if (manifest.entities && Object.keys(manifest.entities).length > 0 && !hasEntityPlugin) {
    nextPlugins.push({
      plugin: 'slingshot-entity',
      config: {
        name: 'slingshot-entity',
        ...(manifest.apiPrefix ? { mountPath: manifest.apiPrefix } : {}),
        manifest: {
          manifestVersion: 1,
          entities: manifest.entities,
          ...(manifest.hooks?.afterAdapters?.length
            ? {
                hooks: {
                  afterAdapters: manifest.hooks.afterAdapters.map(ref => ({
                    handler: ref.handler,
                    ...(ref.params ? { params: ref.params } : {}),
                  })),
                },
              }
            : {}),
        },
      },
    });
  }

  if (
    (hasEntityPlugin || nextPlugins.some(ref => ref.plugin === 'slingshot-entity')) &&
    !hasPermissionsPlugin
  ) {
    nextPlugins.unshift({
      plugin: 'slingshot-permissions',
    });
  }

  return nextPlugins.length === plugins.length ? manifest : { ...manifest, plugins: nextPlugins };
}

/**
 * Walk a raw JSON tree and replace env var placeholders with `process.env` values.
 *
 * Two forms are accepted:
 * - `${ENV_VAR}` — bare uppercase name (letters, digits, underscores, starting with a letter)
 * - `${env:ENV_VAR}` — explicit `env:` prefix form
 *
 * Lowercase tokens like `${importMetaDir}` are left untouched — they go through
 * a separate path-resolution step later.
 *
 * @throws `Error` if a referenced environment variable is not set.
 */
function interpolateEnvVars(value: unknown, path: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:)?([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const env = process.env[name];
      if (env === undefined) {
        throw new Error(
          `[createServerFromManifest] Environment variable "${name}" is not set` +
            (path ? ` (referenced in manifest at ${path})` : ''),
        );
      }
      return env;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnvVars(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateEnvVars(val, path ? `${path}.${key}` : key);
    }
    return out;
  }
  return value;
}

/**
 * Programmatic entry point for manifest-driven server bootstrap.
 *
 * Reads a JSON manifest file, validates it, converts it to a `CreateServerConfig`,
 * and starts the server. The `baseDir` defaults to the manifest file's directory so
 * `${importMetaDir}` placeholders resolve relative to where the manifest lives.
 *
 * **Environment variable interpolation:** String values in the manifest that match
 * `${ENV_VAR}` or `${env:ENV_VAR}` (uppercase letters, digits, and underscores) are
 * replaced with the corresponding `process.env` value before validation.
 * Lowercase placeholders like `${importMetaDir}` are left untouched.
 *
 * **Handler auto-loading:** The pipeline automatically loads handler files into
 * the registry before plugin resolution. By default, it looks for a
 * `slingshot.handlers.ts` file adjacent to the manifest. Use the manifest's `handlers`
 * field to specify a custom file path, a directory of handler files, or `false` to
 * disable auto-loading. The CLI's `--handlers` flag overrides the manifest field
 * via `options.handlersPath`.
 *
 * **Built-in plugin resolution:** Built-in sections like `ssr`, plugins listed in
 * `manifest.plugins`, and the top-level `manifest.entities` section are resolved
 * automatically when their first-party packages are not already registered in the
 * user-supplied `registry`. A fresh registry is created if none is supplied.
 *
 * **Built-in event bus resolution:** When the manifest selects `eventBus: "bullmq"`
 * (or `{ type: "bullmq", config }`), this helper auto-registers the BullMQ adapter
 * if the user registry does not already provide one. The adapter package remains an
 * optional dependency and is loaded only when the manifest selects it.
 *
 * @param manifestPath - Absolute or relative path to the `app.manifest.json` file.
 * @param registry - Optional registry for custom handlers, plugins, event buses, and
 *   secret providers. First-party plugins are loaded automatically when absent.
 * @param options - Optional overrides for `baseDir` and `dryRun`.
 * @returns The running Bun `Server` instance (or a no-op stub when `dryRun` is `true`).
 *
 * @throws `Error` if the manifest file cannot be read or is invalid JSON.
 * @throws `Error` if the manifest fails schema validation.
 * @throws `Error` if a `${UPPER_CASE_VAR}` placeholder references an unset env variable.
 * @throws `Error` if a required plugin package is not installed.
 *
 * @example
 * ```ts
 * import { createServerFromManifest } from '@lastshotlabs/slingshot';
 *
 * await createServerFromManifest(import.meta.dir + '/app.manifest.json');
 * ```
 */
/** Minimal structural type for the OrgService stored in plugin state. */
type SeedOrgService = {
  getOrgBySlug(slug: string): Promise<{ id: string } | null>;
  createOrg(data: {
    name: string;
    slug: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  addOrgMember(
    orgId: string,
    userId: string,
    roles?: string[],
    invitedBy?: string,
  ): Promise<unknown>;
};

/** Plugin state key used by `slingshot-organizations` to store the OrgService. */
const ORG_SERVICE_STATE_KEY = 'slingshot-organizations.orgService';

type BuiltinBullMQAdapterOptions = {
  connection: ReturnType<typeof getRedisConnectionOptions>;
  prefix?: string;
  attempts?: number;
};

type BuiltinBullMQModule = {
  createBullMQAdapter(
    options: BuiltinBullMQAdapterOptions,
  ): import('@lastshotlabs/slingshot-core').SlingshotEventBus;
};

function isBuiltinBullMQModule(value: unknown): value is BuiltinBullMQModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createBullMQAdapter' in value &&
    typeof value.createBullMQAdapter === 'function'
  );
}

function getBuiltinEventBusSpec(
  spec: AppManifest['eventBus'],
): { type: 'bullmq'; config?: Record<string, unknown> } | null {
  if (spec === 'bullmq') return { type: 'bullmq' };
  if (typeof spec === 'object' && spec.type === 'bullmq') {
    return {
      type: 'bullmq',
      config: typeof spec.config === 'object' ? spec.config : undefined,
    };
  }
  return null;
}

async function ensureBuiltinEventBusFactories(
  manifest: AppManifest,
  registry: ManifestHandlerRegistry,
): Promise<void> {
  const builtinSpec = getBuiltinEventBusSpec(manifest.eventBus);
  if (!builtinSpec) return;
  if (registry.hasEventBus(builtinSpec.type)) return;

  const secretBundle = await resolveSecretBundle(manifest.secrets);
  const { redisHost, redisUser, redisPassword } = secretBundle.framework;

  if (!redisHost) {
    throw new Error(
      '[createServerFromManifest] eventBus "bullmq" requires REDIS_HOST via the configured secrets provider.',
    );
  }

  let createBullMQAdapter: BuiltinBullMQModule['createBullMQAdapter'];
  try {
    const bullmqModuleUnknown: unknown = await import('@lastshotlabs/slingshot-bullmq');
    if (!isBuiltinBullMQModule(bullmqModuleUnknown)) {
      throw new TypeError(
        '[createServerFromManifest] Invalid "@lastshotlabs/slingshot-bullmq" module shape.',
      );
    }
    createBullMQAdapter = options => bullmqModuleUnknown.createBullMQAdapter(options);
  } catch (err) {
    throw new Error(
      '[createServerFromManifest] eventBus "bullmq" requires package "@lastshotlabs/slingshot-bullmq" plus peer dependencies "bullmq" and "ioredis". ' +
        'Run: bun add @lastshotlabs/slingshot-bullmq bullmq ioredis',
      { cause: err },
    );
  }

  const connection = getRedisConnectionOptions({
    host: redisHost,
    user: redisUser,
    password: redisPassword,
  });

  registry.registerEventBus('bullmq', config => {
    const rawConfig: Record<string, unknown> = config ?? {};
    const adapterOptions: BuiltinBullMQAdapterOptions = {
      connection,
    };

    if (typeof rawConfig.prefix === 'string') {
      adapterOptions.prefix = rawConfig.prefix;
    }
    if (typeof rawConfig.attempts === 'number') {
      adapterOptions.attempts = rawConfig.attempts;
    }

    return createBullMQAdapter(adapterOptions);
  });
}

/**
 * Apply manifest seed data after the server has started.
 *
 * Creates users and orgs that do not yet exist (idempotent — users checked by
 * email, orgs checked by slug). Safe to call on every boot.
 */
async function runManifestSeed(
  server: Server<object>,
  seed: NonNullable<AppManifest['seed']>,
): Promise<void> {
  const ctx = getServerContext(server);
  if (!ctx) {
    console.warn('[manifest seed] Could not retrieve server context — seed skipped.');
    return;
  }

  const runtime = getAuthRuntimeContext(ctx.pluginState);
  const permsState = getPermissionsStateOrNull(ctx.pluginState) as
    | ({ adapter: PermissionsAdapter } & object)
    | null;
  const orgService = ctx.pluginState.get(ORG_SERVICE_STATE_KEY) as SeedOrgService | undefined;

  // Track seeded user IDs by email for org member wiring.
  const seededUserIds = new Map<string, string>();

  // --- Users ---
  for (const seedUser of seed.users ?? []) {
    const existing = await runtime.adapter.findByEmail(seedUser.email);
    if (existing) {
      console.log(`[manifest seed] User '${seedUser.email}' already exists — skipping.`);
      seededUserIds.set(seedUser.email, existing.id);
      continue;
    }

    const hash = await runtime.password.hash(seedUser.password);
    const { id } = await runtime.adapter.create(seedUser.email, hash);
    seededUserIds.set(seedUser.email, id);
    console.log(`[manifest seed] Created user '${seedUser.email}' (id: ${id}).`);

    if (seedUser.superAdmin) {
      if (!permsState) {
        console.warn(
          `[manifest seed] superAdmin requested for '${seedUser.email}' but permissions plugin is not running — grant skipped.`,
        );
      } else {
        await permsState.adapter.createGrant({
          subjectId: id,
          subjectType: 'user',
          tenantId: null,
          resourceType: null,
          resourceId: null,
          roles: [SUPER_ADMIN_ROLE],
          effect: 'allow',
          grantedBy: 'manifest-seed',
        });
        console.log(`[manifest seed] Granted super-admin to '${seedUser.email}'.`);
      }
    }
  }

  // --- Orgs ---
  if ((seed.orgs ?? []).length > 0 && !orgService) {
    console.warn(
      '[manifest seed] seed.orgs defined but slingshot-organizations plugin is not running — org seed skipped.',
    );
    return;
  }

  // orgService is guaranteed non-null here: the guard above returns early when
  // seed.orgs is non-empty and orgService is absent.
  if (!orgService) return;

  for (const seedOrg of seed.orgs ?? []) {
    const existing = await orgService.getOrgBySlug(seedOrg.slug);
    if (existing) {
      console.log(`[manifest seed] Org '${seedOrg.slug}' already exists — skipping.`);
      continue;
    }

    const org = await orgService.createOrg({
      name: seedOrg.name,
      slug: seedOrg.slug,
      tenantId: seedOrg.tenantId,
      metadata: seedOrg.metadata,
    });
    console.log(`[manifest seed] Created org '${seedOrg.slug}' (id: ${org.id}).`);

    for (const member of seedOrg.members ?? []) {
      // Look up user ID: prefer seeded users, fall back to auth adapter lookup.
      let userId = seededUserIds.get(member.email);
      if (!userId) {
        const found = await runtime.adapter.findByEmail(member.email);
        if (!found) {
          console.warn(
            `[manifest seed] Member '${member.email}' for org '${seedOrg.slug}' not found — skipping.`,
          );
          continue;
        }
        userId = found.id;
      }
      await orgService.addOrgMember(org.id, userId, member.roles ?? [], 'manifest-seed');
      console.log(`[manifest seed] Added '${member.email}' to org '${seedOrg.slug}'.`);
    }
  }
}

export async function createServerFromManifest(
  manifestPath: string,
  registry?: ManifestHandlerRegistry,
  options?: CreateServerFromManifestOptions,
): Promise<Server<object>> {
  const absPath = resolve(manifestPath);
  const baseDir = typeof options?.baseDir === 'string' ? options.baseDir : dirname(absPath);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[createServerFromManifest] Failed to read manifest at '${absPath}': ${message}`,
      { cause: err },
    );
  }

  // Substitute ${UPPER_CASE_VAR} placeholders before validation.
  raw = interpolateEnvVars(raw, '');

  const result = validateAppManifest(raw);
  if (!result.success) {
    throw new Error(
      `[createServerFromManifest] Invalid manifest at '${absPath}':\n` + result.errors.join('\n'),
    );
  }

  for (const warning of result.warnings) {
    console.warn(`[createServerFromManifest] ${warning}`);
  }

  const manifestWithSyntheticPlugins = addSyntheticManifestPlugins(result.manifest);

  // Auto-load handler files into the registry before built-in plugin loading,
  // since plugin factories may reference handlers from the registry.
  let effectiveRegistry = registry;
  if (!effectiveRegistry) effectiveRegistry = createManifestHandlerRegistry();
  await loadHandlersIntoRegistry(
    effectiveRegistry,
    options?.handlersPath !== undefined
      ? options.handlersPath // CLI override takes precedence
      : result.manifest.handlers, // manifest field
    baseDir,
  );

  await ensureBuiltinEventBusFactories(result.manifest, effectiveRegistry);

  // Pre-load builtin plugins for manifest entries not yet in the user registry.
  const pluginRefs = getManifestPluginRefs(manifestWithSyntheticPlugins);
  if (pluginRefs.length) {
    for (const ref of pluginRefs) {
      if (!effectiveRegistry.hasPlugin(ref.plugin)) {
        const factory = await loadBuiltinPlugin(ref.plugin);
        if (factory) {
          effectiveRegistry.registerPlugin(
            ref.plugin,
            createBuiltinPluginFactory(ref.plugin, factory, effectiveRegistry, baseDir),
          );
        }
      }
    }
  }

  // Bridge ManifestHandlerRegistry handlers and hooks into entity-level
  // registries so the synthetic entity plugin can resolve them.
  // Custom operation handlers go into an EntityHandlerRegistry;
  // afterAdapters hooks go into an EntityPluginHookRegistry.
  // Same pattern slingshot-assets uses via its manifestRuntime.
  if (manifestWithSyntheticPlugins.entities) {
    const handlerNames = new Set<string>();
    for (const entity of Object.values(manifestWithSyntheticPlugins.entities)) {
      if (!entity.operations) continue;
      for (const op of Object.values(entity.operations)) {
        if (op.kind === 'custom' && op.handler) {
          handlerNames.add(op.handler);
        }
      }
    }

    const hookRefs = result.manifest.hooks?.afterAdapters ?? [];

    if (handlerNames.size > 0 || hookRefs.length > 0) {
      const entityPluginRef = manifestWithSyntheticPlugins.plugins?.find(
        ref => ref.plugin === 'slingshot-entity',
      );
      if (entityPluginRef?.config) {
        const manifestRuntime: Record<string, unknown> =
          (entityPluginRef.config.manifestRuntime as Record<string, unknown> | undefined) ?? {};

        if (handlerNames.size > 0) {
          const { createEntityHandlerRegistry } = await import('@lastshotlabs/slingshot-entity');
          const entityHandlers = createEntityHandlerRegistry();
          for (const name of handlerNames) {
            if (effectiveRegistry.hasHandler(name)) {
              entityHandlers.register(
                name,
                effectiveRegistry.resolveHandler(name) as Parameters<
                  typeof entityHandlers.register
                >[1],
              );
            }
          }
          manifestRuntime.customHandlers = entityHandlers;
        }

        if (hookRefs.length > 0) {
          const { createEntityPluginHookRegistry } = await import('@lastshotlabs/slingshot-entity');
          const entityHooks = createEntityPluginHookRegistry();
          for (const ref of hookRefs) {
            if (effectiveRegistry.hasHook(ref.handler)) {
              // Opaque boundary: ManifestHandlerRegistry stores HookFunction(ctx: unknown),
              // EntityPluginHookRegistry expects EntityPluginAfterAdaptersHook.
              entityHooks.register(
                ref.handler,
                effectiveRegistry.resolveHook(ref.handler) as unknown as Parameters<
                  typeof entityHooks.register
                >[1],
              );
            }
          }
          manifestRuntime.hooks = entityHooks;
        }

        entityPluginRef.config.manifestRuntime = manifestRuntime;
      }
    }
  }

  const config = manifestToAppConfig(manifestWithSyntheticPlugins, effectiveRegistry, {
    ...options,
    baseDir,
  });

  if (options?.dryRun) return { stop: async () => {} } as unknown as Server<object>;

  const server = (await createServer(config)) as unknown as Server<object>;

  const seed = result.manifest.seed;
  if (seed && (seed.users?.length || seed.orgs?.length)) {
    await runManifestSeed(server, seed);
  }

  return server;
}
