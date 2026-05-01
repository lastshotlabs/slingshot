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
  let mod: unknown;
  try {
    mod = await import(manifestModulePath);
  } catch (err) {
    throw new Error(
      `Failed to import ${manifestModulePath}. The Lambda runtime requires the root ` +
        `@lastshotlabs/slingshot package to be bundled in the deployment. ` +
        `Ensure the manifest subpath is included in your bundle. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (mod as { resolveManifestConfig: ResolveManifestConfig }).resolveManifestConfig(
    manifestPathOrObject,
    registry,
    options,
  );
}

async function createApp(config: Record<string, unknown>): Promise<{ ctx: SlingshotContext }> {
  const appModulePath = '@lastshotlabs/slingshot';
  let mod: unknown;
  try {
    mod = await import(appModulePath);
  } catch (err) {
    throw new Error(
      `Failed to import ${appModulePath}. The Lambda runtime requires the root ` +
        `@lastshotlabs/slingshot package to be bundled in the deployment. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (mod as { createApp(config: Record<string, unknown>): Promise<{ ctx: SlingshotContext }> }).createApp(config);
}

/**
 * Resolve the manifest, create the app, and return the Lambda bootstrap state.
 */
export async function bootstrap(config: FunctionsRuntimeConfig): Promise<BootstrapResult> {
  let runtime = config.runtime;
  if (!runtime) {
    try {
      runtime = (await import('@lastshotlabs/slingshot-runtime-node')).nodeRuntime();
    } catch (err) {
      throw new Error(
        `Failed to import @lastshotlabs/slingshot-runtime-node. The Lambda runtime requires ` +
          `slingshot-runtime-node to be bundled in the deployment. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
