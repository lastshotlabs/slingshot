import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  FunctionsRuntimeConfig,
  SlingshotHandler,
  TriggerOpts,
} from '@lastshotlabs/slingshot-core';
import { HandlerResolutionError } from './errors';
import { type LambdaTriggerKind, createLambdaRuntime } from './runtime';
import { resolveLambdaTrigger } from './triggers';

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
    /**
     * Optional: when present, lets us list the exports the loaded file
     * registered so we can include them in resolution failures.
     */
    listHandlers?(): readonly string[];
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
 * Resolve the on-disk handlers file path from `options.handlersPath` so we can
 * fail fast with a precise "file not found" message, and so resolution-failure
 * errors can include the resolved path.
 *
 * Returns `undefined` when the path cannot be statically resolved (directory
 * mode, disabled, or default-relative-to-manifest where we don't own the
 * baseDir computation).
 */
function resolveHandlersFilePath(
  manifest: string | Record<string, unknown>,
  handlersPath: string | { dir: string } | false | undefined,
): string | undefined {
  if (handlersPath === false || handlersPath === undefined) return undefined;
  if (typeof handlersPath === 'object') return undefined;
  if (isAbsolute(handlersPath)) return handlersPath;
  // Best-effort: when the manifest is a path on disk, resolve relative to its
  // directory. Otherwise (object manifest) resolve against cwd, matching the
  // convention used by resolveManifestConfig for object manifests.
  if (typeof manifest === 'string') {
    return resolve(dirname(manifest), handlersPath);
  }
  return resolve(process.cwd(), handlersPath);
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
  const handlersFilePath = resolveHandlersFilePath(manifest, options?.handlersPath);

  // Fail fast when the operator pointed at a file that does not exist on disk:
  // the underlying manifest loader silently no-ops in this case, so the
  // operator would otherwise see a confusing "Unknown handler" message far
  // downstream from the real cause (a typo'd path).
  if (handlersFilePath !== undefined && !existsSync(handlersFilePath)) {
    throw new HandlerResolutionError(
      `Handlers file not found at ${handlersFilePath}. ` +
        'Check the manifest "handlers" field (or `handlersPath` option) and verify the file exists.',
      {
        exportName: '<unknown>',
        handlerRef: '<unknown>',
        handlersPath: handlersFilePath,
      },
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveManifestConfig>>;
  try {
    resolved = await resolveManifestConfig(manifest, undefined, {
      handlersPath: options?.handlersPath,
    });
  } catch (err) {
    // The manifest loader imports the handlers file under the hood; surface
    // the original error message and the file we were trying to import so the
    // operator can spot a syntax error or bad import inside their handlers.
    const reason = err instanceof Error ? err.message : String(err);
    throw new HandlerResolutionError(
      `Failed to load handlers${handlersFilePath ? ` from ${handlersFilePath}` : ''}: ${reason}`,
      {
        exportName: '<unknown>',
        handlerRef: '<unknown>',
        ...(handlersFilePath ? { handlersPath: handlersFilePath } : {}),
        cause: err,
      },
    );
  }

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
  // Validate every trigger kind up-front so a typo in the manifest is caught at
  // bootstrap (deploy time) rather than on the first invoke. resolveLambdaTrigger
  // throws on unknown kinds with a clear message.
  for (const [exportName, lambdaConfig] of Object.entries(lambdas)) {
    try {
      resolveLambdaTrigger(lambdaConfig.trigger as LambdaTriggerKind);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Manifest lambda '${exportName}' has invalid trigger '${lambdaConfig.trigger}': ${reason}`,
        { cause: err },
      );
    }
  }

  for (const [exportName, lambdaConfig] of Object.entries(lambdas)) {
    let resolvedHandler: unknown;
    try {
      resolvedHandler = resolved.registry.resolveHandler(lambdaConfig.handler);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const availableExports = resolved.registry.listHandlers?.();
      const exportList = availableExports
        ? ` Available exports: [${availableExports.join(', ')}].`
        : '';
      throw new HandlerResolutionError(
        `Manifest lambda '${exportName}' could not resolve handler '${lambdaConfig.handler}'` +
          `${handlersFilePath ? ` from ${handlersFilePath}` : ''}.${exportList} Original error: ${reason}`,
        {
          exportName,
          handlerRef: lambdaConfig.handler,
          ...(handlersFilePath ? { handlersPath: handlersFilePath } : {}),
          ...(availableExports ? { availableExports } : {}),
          cause: err,
        },
      );
    }

    if (!isSlingshotHandler(resolvedHandler)) {
      throw new HandlerResolutionError(
        `Manifest lambda '${exportName}' handler '${lambdaConfig.handler}' is not a SlingshotHandler` +
          `${handlersFilePath ? ` (loaded from ${handlersFilePath})` : ''}. ` +
          'Make sure the export is built with `defineHandler(...)` and exposes `name`, `input`, `output`, and `invoke`.',
        {
          exportName,
          handlerRef: lambdaConfig.handler,
          ...(handlersFilePath ? { handlersPath: handlersFilePath } : {}),
        },
      );
    }

    wrapped[exportName] = runtime.wrap(resolvedHandler, lambdaConfig.trigger as LambdaTriggerKind, {
      idempotency: lambdaConfig.idempotency as TriggerOpts['idempotency'],
    });
  }

  return wrapped;
}
