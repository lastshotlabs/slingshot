import {
  resolveAdminManifestConfig,
  resolveSearchManifestConfig,
  resolveSsrManifestConfig,
  resolveWebhookManifestConfig,
} from './manifestBuiltinConfig';
import type { ManifestHandlerRegistry, PluginFactory } from './manifestHandlerRegistry';

/**
 * Built-in plugin dispatch table.
 *
 * Maps manifest plugin names to their package and factory function.
 * Used by `slingshot start` to auto-instantiate first-party plugins without
 * requiring the consumer to import or register them.
 *
 * To add a new first-party plugin: add one entry to BUILTIN_PLUGINS.
 * No other changes required.
 */

export interface BuiltinPluginEntry {
  /** The npm package containing the plugin factory. */
  pkg: string;
  /** The named export to call as the factory function. */
  factory: string;
}

/**
 * Wrap a built-in plugin factory so manifest-only config can be resolved into
 * runtime values before the plugin is instantiated.
 *
 * @remarks
 * Most built-in plugins accept JSON-serializable config as-is. A small subset
 * still needs handler-ref or path resolution in manifest mode:
 * - `slingshot-ssr` resolves `renderer`, `runtime`, `isr.adapter`, and relative paths
 * - `slingshot-webhooks` resolves handler-backed guards, queues, adapters, and inbound providers
 */
export function createBuiltinPluginFactory(
  name: string,
  factory: (config?: Record<string, unknown>) => unknown,
  registry: ManifestHandlerRegistry | undefined,
  baseDir: string,
): PluginFactory {
  return (config?: Record<string, unknown>) => {
    const rawConfig = config ?? {};

    if (name === 'slingshot-ssr') {
      return factory(
        resolveSsrManifestConfig(
          rawConfig,
          registry,
          baseDir,
          'manifest.plugins["slingshot-ssr"].config',
        ),
      ) as ReturnType<PluginFactory>;
    }

    if (name === 'slingshot-webhooks') {
      return factory(
        resolveWebhookManifestConfig(rawConfig, registry),
      ) as ReturnType<PluginFactory>;
    }

    if (name === 'slingshot-search') {
      return factory(resolveSearchManifestConfig(rawConfig)) as ReturnType<PluginFactory>;
    }

    if (name === 'slingshot-admin') {
      const adminResult = resolveAdminManifestConfig(rawConfig);
      const plugin = factory(adminResult.config) as ReturnType<PluginFactory>;

      if (adminResult.bind && adminResult.deps.length > 0) {
        const origSetupRoutes = plugin.setupRoutes?.bind(plugin);
        const bindFn = adminResult.bind;
        const manifestDeps = adminResult.deps;
        const wrappedPlugin: ReturnType<PluginFactory> = {
          ...plugin,
          dependencies: [...new Set([...(plugin.dependencies ?? []), ...manifestDeps])],
          async setupRoutes(ctx) {
            const { getContext } = await import('@lastshotlabs/slingshot-core');
            const appCtx = getContext(ctx.app);
            bindFn(appCtx.pluginState);
            if (origSetupRoutes) await origSetupRoutes(ctx);
          },
        };

        return wrappedPlugin;
      }

      return plugin;
    }

    return factory(rawConfig) as ReturnType<PluginFactory>;
  };
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPluginEntry> = {
  'slingshot-auth': { pkg: '@lastshotlabs/slingshot-auth', factory: 'createAuthPlugin' },
  'slingshot-permissions': {
    pkg: '@lastshotlabs/slingshot-permissions',
    factory: 'createPermissionsPlugin',
  },
  'slingshot-entity': {
    pkg: '@lastshotlabs/slingshot-entity',
    factory: 'createEntityPlugin',
  },
  'slingshot-community': {
    pkg: '@lastshotlabs/slingshot-community',
    factory: 'createCommunityPlugin',
  },
  'slingshot-deep-links': {
    pkg: '@lastshotlabs/slingshot-deep-links',
    factory: 'createDeepLinksPlugin',
  },
  'slingshot-chat': { pkg: '@lastshotlabs/slingshot-chat', factory: 'createChatPlugin' },
  'slingshot-interactions': {
    pkg: '@lastshotlabs/slingshot-interactions',
    factory: 'createInteractionsPlugin',
  },
  'slingshot-ssr': { pkg: '@lastshotlabs/slingshot-ssr', factory: 'createSsrPlugin' },
  'slingshot-image': { pkg: '@lastshotlabs/slingshot-image', factory: 'createImagePlugin' },
  'slingshot-emoji': { pkg: '@lastshotlabs/slingshot-emoji', factory: 'createEmojiPlugin' },
  'slingshot-embeds': { pkg: '@lastshotlabs/slingshot-embeds', factory: 'createEmbedsPlugin' },
  'slingshot-gifs': { pkg: '@lastshotlabs/slingshot-gifs', factory: 'createGifsPlugin' },
  'slingshot-admin': { pkg: '@lastshotlabs/slingshot-admin', factory: 'createAdminPlugin' },
  'slingshot-assets': { pkg: '@lastshotlabs/slingshot-assets', factory: 'createAssetsPlugin' },
  'slingshot-oauth': { pkg: '@lastshotlabs/slingshot-oauth', factory: 'createOAuthPlugin' },
  'slingshot-oidc': { pkg: '@lastshotlabs/slingshot-oidc', factory: 'createOidcPlugin' },
  'slingshot-m2m': { pkg: '@lastshotlabs/slingshot-m2m', factory: 'createM2MPlugin' },
  'slingshot-mail': { pkg: '@lastshotlabs/slingshot-mail', factory: 'createMailPlugin' },
  'slingshot-notifications': {
    pkg: '@lastshotlabs/slingshot-notifications',
    factory: 'createNotificationsPlugin',
  },
  'slingshot-organizations': {
    pkg: '@lastshotlabs/slingshot-organizations',
    factory: 'createOrganizationsPlugin',
  },
  'slingshot-game-engine': {
    pkg: '@lastshotlabs/slingshot-game-engine',
    factory: 'createGameEnginePlugin',
  },
  'slingshot-polls': { pkg: '@lastshotlabs/slingshot-polls', factory: 'createPollsPlugin' },
  'slingshot-push': { pkg: '@lastshotlabs/slingshot-push', factory: 'createPushPlugin' },
  'slingshot-scim': { pkg: '@lastshotlabs/slingshot-scim', factory: 'createScimPlugin' },
  'slingshot-search': { pkg: '@lastshotlabs/slingshot-search', factory: 'createSearchPlugin' },
  'slingshot-webhooks': {
    pkg: '@lastshotlabs/slingshot-webhooks',
    factory: 'createWebhookPlugin',
  },
};

/**
 * Dynamically import and return a built-in plugin factory by manifest name.
 *
 * Returns null if the name is not a known built-in plugin.
 * Throws a clear error if the plugin is referenced but its package is not installed.
 */
export async function loadBuiltinPlugin(
  name: string,
): Promise<((config?: Record<string, unknown>) => unknown) | null> {
  const entry: BuiltinPluginEntry | undefined = (
    BUILTIN_PLUGINS as Record<string, BuiltinPluginEntry | undefined>
  )[name];
  if (!entry) return null;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(entry.pkg)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `[builtinPlugins] Plugin "${name}" requires package "${entry.pkg}" which is not installed. ` +
        `Run: bun add ${entry.pkg}`,
    );
  }

  const factory = mod[entry.factory];
  if (typeof factory !== 'function') {
    throw new Error(`[builtinPlugins] Package "${entry.pkg}" does not export "${entry.factory}".`);
  }

  return factory as (config?: Record<string, unknown>) => unknown;
}
