import type { FunctionsRuntimeConfig, SlingshotContext } from '@lastshotlabs/slingshot-core';

/**
 * Cached Lambda bootstrap state returned by {@link bootstrap}.
 */
export interface BootstrapResult {
  /** Live Slingshot application context used by wrapped handlers. */
  ctx: SlingshotContext;
  /** Dispose of the bootstrapped app and release any runtime resources. */
  teardown(): Promise<void>;
}

type ResolveManifestConfig = (
  manifestPathOrObject: string | Record<string, unknown>,
  registry?: {
    resolveHandler(name: string, params?: Record<string, unknown>): unknown;
    hasHandler(name: string): boolean;
  },
  options?: { handlersPath?: string | { dir: string } | false },
) => Promise<{
  config: Record<string, unknown>;
  manifest: Record<string, unknown>;
  registry: {
    resolveHandler(name: string, params?: Record<string, unknown>): unknown;
    hasHandler(name: string): boolean;
  };
}>;

async function resolveManifestConfig(
  manifestPathOrObject: string | Record<string, unknown>,
  registry?: {
    resolveHandler(name: string, params?: Record<string, unknown>): unknown;
    hasHandler(name: string): boolean;
  },
  options?: { handlersPath?: string | { dir: string } | false },
) {
  const manifestModulePath = '@lastshotlabs/slingshot/manifest';
  const mod = (await import(manifestModulePath)) as unknown as {
    resolveManifestConfig: ResolveManifestConfig;
  };
  return mod.resolveManifestConfig(manifestPathOrObject, registry, options);
}

async function createApp(config: Record<string, unknown>): Promise<{ ctx: SlingshotContext }> {
  const appModulePath = '@lastshotlabs/slingshot';
  const mod = (await import(appModulePath)) as unknown as {
    createApp(config: Record<string, unknown>): Promise<{ ctx: SlingshotContext }>;
  };
  return mod.createApp(config);
}

/**
 * Resolve the manifest, create the app, and return the Lambda bootstrap state.
 */
export async function bootstrap(config: FunctionsRuntimeConfig): Promise<BootstrapResult> {
  const runtime =
    config.runtime ?? (await import('@lastshotlabs/slingshot-runtime-node')).nodeRuntime();
  const resolved = await resolveManifestConfig(config.manifest, undefined, {
    handlersPath: config.handlersPath,
  });
  const { ctx } = await createApp({
    ...resolved.config,
    runtime,
  });
  return {
    ctx,
    teardown: async () => {
      await ctx.destroy();
    },
  };
}
