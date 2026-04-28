import type { ZodType } from 'zod';
import type {
  FunctionsRuntime,
  FunctionsRuntimeConfig,
  SlingshotContext,
  SlingshotHandler,
  TriggerOpts,
} from '@lastshotlabs/slingshot-core';
import { type BootstrapResult, bootstrap } from './bootstrap';
import { invokeWithAdapter } from './invocationLoop';
import { isStreamingSupported, wrapStreamingHandler } from './streaming';
import { type LambdaTriggerKind, resolveLambdaTrigger } from './triggers';

type LambdaContextLike = {
  awsRequestId?: string;
};

/**
 * Lambda-specific runtime options. Extends the shared {@link FunctionsRuntimeConfig}
 * with Lambda-only knobs that have no analogue on other runtimes (Bun, Node, Edge).
 */
export interface LambdaRuntimeOptions extends FunctionsRuntimeConfig {
  /**
   * When `true`, wrap each handler returned from `wrap()` in
   * `awslambda.streamifyResponse(...)` so the Lambda runtime can stream the
   * response body back to the client.
   *
   * Streaming is only available in Lambda execution environments that expose
   * the `awslambda` global with a `streamifyResponse` function (Function URLs
   * configured for `RESPONSE_STREAM`, certain managed Node.js runtimes, custom
   * runtimes that ship the shim, etc.). When the global is missing — unit
   * tests, non-streaming Lambdas, or custom runtimes without the shim — the
   * wrapper falls back to a regular request/response handler. The handler
   * itself is unchanged in either case; only the outer adapter differs.
   *
   * Default: `false`.
   */
  streamingHandler?: boolean;
}

/**
 * AWS Lambda runtime that wraps Slingshot handlers with trigger adapters.
 */
export interface LambdaRuntime extends Omit<FunctionsRuntime, 'wrap'> {
  wrap<TInput extends ZodType, TOutput extends ZodType>(
    handler: SlingshotHandler<TInput, TOutput>,
    trigger: LambdaTriggerKind,
    opts?: TriggerOpts,
  ): (event: unknown, context: LambdaContextLike) => Promise<unknown>;
}

/**
 * Create an AWS Lambda runtime with cold-start bootstrap caching and trigger-aware wrappers.
 *
 * On the first invocation, the runtime bootstraps the Slingshot app from the provided
 * manifest and caches the resulting context. Subsequent invocations reuse the cached
 * context (warm start). The `onInit` hook is called once after the first bootstrap.
 *
 * Registers a `SIGTERM` handler (once per process) if `config.hooks.onShutdown` is provided.
 * The shutdown hook runs best-effort within `shutdownTimeoutMs` (default: 1500ms). Any
 * rejection from the hook itself is caught and logged so resource cleanup never tears
 * down the Lambda container with an unhandled rejection.
 *
 * **Trigger validation.** `wrap()` validates the supplied `trigger` kind eagerly so
 * misconfiguration surfaces at deploy time (when the wrapper is constructed) rather than
 * on the first invocation hours later.
 *
 * @param config - Runtime configuration: manifest, optional custom runtime, lifecycle hooks,
 *   and shutdown timeout.
 * @returns A `LambdaRuntime` with `wrap()`, `getContext()`, and `shutdown()`.
 *
 * @example
 * ```ts
 * import { createLambdaRuntime } from '@lastshotlabs/slingshot-runtime-lambda';
 *
 * const runtime = createLambdaRuntime({ manifest: './app.manifest.json' });
 *
 * export const handler = runtime.wrap(myHandler, 'sqs');
 * ```
 */
export function createLambdaRuntime(
  config: FunctionsRuntimeConfig | LambdaRuntimeOptions,
): LambdaRuntime {
  let cached: BootstrapResult | null = null;
  let coldStart = true;
  let shutdownRegistered = false;
  const streamingRequested = (config as LambdaRuntimeOptions).streamingHandler === true;
  // Resolve once at construction time. Logging here makes the deploy-time
  // fallback visible in CloudWatch even before the first invocation.
  const streamingActive = streamingRequested && isStreamingSupported();
  if (streamingRequested && !streamingActive) {
    console.warn(
      '[lambda] streamingHandler:true requested but globalThis.awslambda.streamifyResponse is not available — falling back to non-streaming handlers',
    );
  }

  async function ensureBootstrap(): Promise<BootstrapResult> {
    if (!cached) {
      const bootstrapped = await bootstrap(config);
      try {
        await config.hooks?.onInit?.(bootstrapped.ctx);
      } catch (err) {
        await bootstrapped.teardown().catch(() => {});
        throw err;
      }
      cached = bootstrapped;
    }
    if (!shutdownRegistered && config.hooks?.onShutdown) {
      shutdownRegistered = true;
      const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 1500;
      process.once('SIGTERM', () => {
        // Wrap the hook in a Promise so synchronous throws are also captured.
        const hookPromise = Promise.resolve()
          .then(() => config.hooks?.onShutdown?.(cached?.ctx as SlingshotContext))
          .catch(err => {
            // Hook rejected — log and continue. Without this, the rejection
            // would surface as an unhandledRejection on the Lambda container
            // during shutdown and obscure the real cause.
            console.error('[lambda] onShutdown hook threw during SIGTERM:', err);
          });
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>(resolve => {
          timeoutId = setTimeout(() => {
            console.warn(
              `[lambda] onShutdown hook exceeded ${shutdownTimeoutMs}ms — abandoning wait`,
            );
            resolve();
          }, shutdownTimeoutMs);
        });
        void Promise.race([hookPromise, timeoutPromise]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
      });
    }
    return cached;
  }

  return {
    wrap(handler, trigger, opts) {
      // Eager trigger validation — surfaces misconfiguration at module init,
      // not on the first invoke. resolveLambdaTrigger throws on unknown kinds.
      const adapter = resolveLambdaTrigger(trigger);
      const baseHandler = async (event: unknown, context: LambdaContextLike) => {
        const runtime = await ensureBootstrap();
        try {
          return await invokeWithAdapter(
            handler,
            adapter,
            event,
            runtime.ctx,
            config.hooks,
            opts,
            coldStart,
            context,
            config.handlerTimeoutMs,
          );
        } finally {
          coldStart = false;
        }
      };
      // Streaming is only meaningful for HTTP-shaped triggers. For event-source
      // triggers (sqs/kinesis/etc.) Lambda ignores the streaming wrapper. We
      // still apply it uniformly when requested so the same `wrap()` call is
      // a drop-in replacement; the streaming shim is a passthrough for non-HTTP
      // payloads.
      if (streamingActive) {
        return wrapStreamingHandler(baseHandler);
      }
      return baseHandler;
    },
    async getContext() {
      return (await ensureBootstrap()).ctx;
    },
    async shutdown() {
      if (!cached) return;
      try {
        await config.hooks?.onShutdown?.(cached.ctx);
      } catch (err) {
        console.error('[lambda] onShutdown hook threw during shutdown():', err);
      }
      await cached.teardown();
      cached = null;
      coldStart = true;
    },
  };
}

export type { LambdaTriggerKind } from './triggers';
