import type { AppManifest, PluginRef } from './manifest';

function clonePluginRef(ref: PluginRef): PluginRef {
  return {
    plugin: ref.plugin,
    ...(ref.config ? { config: { ...ref.config } } : {}),
  };
}

/**
 * Build the effective SSR plugin config from the top-level manifest sections.
 *
 * Shared runtime/build paths stay single-sourced:
 * - `ssg.outDir` becomes the default SSR `staticDir` when omitted
 */
export function buildManifestSsrPluginConfig(
  manifest: AppManifest,
): Record<string, unknown> | null {
  if (!manifest.ssr) return null;

  const staticDir = manifest.ssr.staticDir ?? manifest.ssg?.outDir;

  return {
    ...manifest.ssr,
    ...(manifest.pages ? { pages: manifest.pages } : {}),
    ...(manifest.navigation ? { navigation: manifest.navigation } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
  };
}

/**
 * Collect the plugin refs implied by a manifest.
 *
 * Top-level first-party sections such as `ssr` synthesize their corresponding
 * built-in plugin ref so the rest of the bootstrap path stays uniform.
 */
export function getManifestPluginRefs(manifest: AppManifest): PluginRef[] {
  const refs = (manifest.plugins ?? []).map(clonePluginRef);
  const ssrConfig = buildManifestSsrPluginConfig(manifest);

  if (ssrConfig) {
    const hasExplicitSsrPlugin = refs.some(ref => ref.plugin === 'slingshot-ssr');
    if (hasExplicitSsrPlugin) {
      throw new Error(
        '[manifest plugin refs] manifest.ssr cannot be combined with ' +
          'manifest.plugins entry "slingshot-ssr". Use the top-level "ssr" section only.',
      );
    }

    refs.push({
      plugin: 'slingshot-ssr',
      config: ssrConfig,
    });
  }

  return refs;
}
