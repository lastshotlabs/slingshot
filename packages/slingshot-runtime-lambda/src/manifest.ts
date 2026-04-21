import type {
  FunctionsRuntimeConfig,
  SlingshotHandler,
  TriggerOpts,
} from '@lastshotlabs/slingshot-core';
import { type LambdaTriggerKind, createLambdaRuntime } from './runtime';

type ResolveManifestConfig = (
  manifestPathOrObject: string | Record<string, unknown>,
  registry?: {
    resolveHandler(name: string, params?: Record<string, unknown>): unknown;
    hasHandler(name: string): boolean;
  },
  options?: { handlersPath?: string | { dir: string } | false },
) => Promise<{
  config: Record<string, unknown>;
  manifest: {
    lambdas?: Record<
      string,
      { handler: string; trigger: string; idempotency?: boolean | TriggerOpts['idempotency'] }
    >;
  };
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

function isSlingshotHandler(value: unknown): value is SlingshotHandler {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof (value as { invoke?: unknown }).invoke === 'function' &&
    'name' in value &&
    'input' in value &&
    'output' in value
  );
}

/**
 * Resolve `manifest.lambdas` and return AWS Lambda-compatible wrapped exports keyed by
 * the manifest binding names.
 */
export async function createFunctionsFromManifest(
  manifest: string | Record<string, unknown>,
  options?: Pick<FunctionsRuntimeConfig, 'runtime' | 'hooks' | 'handlersPath'>,
): Promise<
  Record<string, (event: unknown, context: { awsRequestId?: string }) => Promise<unknown>>
> {
  const resolved = await resolveManifestConfig(manifest, undefined, {
    handlersPath: options?.handlersPath,
  });
  const runtime = createLambdaRuntime({
    manifest,
    runtime: options?.runtime,
    hooks: options?.hooks,
    handlersPath: options?.handlersPath,
  });

  const lambdas = resolved.manifest.lambdas ?? {};
  const wrapped: Record<
    string,
    (event: unknown, context: { awsRequestId?: string }) => Promise<unknown>
  > = {};
  for (const [exportName, lambdaConfig] of Object.entries(lambdas)) {
    const resolvedHandler = resolved.registry.resolveHandler(lambdaConfig.handler);
    if (!isSlingshotHandler(resolvedHandler)) {
      throw new Error(
        `Manifest lambda '${exportName}' handler '${lambdaConfig.handler}' is not a SlingshotHandler`,
      );
    }

    wrapped[exportName] = runtime.wrap(resolvedHandler, lambdaConfig.trigger as LambdaTriggerKind, {
      idempotency: lambdaConfig.idempotency as TriggerOpts['idempotency'],
    });
  }

  return wrapped;
}
