import type { ZodType } from 'zod';
import { type Logger, createConsoleLogger } from '@lastshotlabs/slingshot-core';
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

/**
 * Default upper-bound on graceful drain in `SIGTERM` (P-LAMBDA-1).
 * Lambda's actual SIGTERM-to-SIGKILL grace window is platform-defined and
 * varies by runtime (typically ~6s for managed runtimes). 5 s is a safe
 * default that leaves headroom for the user-supplied `onShutdown` hook.
 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;

let runtimeLogger: Logger = createConsoleLogger({ base: { runtime: 'lambda' } });

/**
 * Replace the runtime-level structured logger. Pass `null` to reset to the
 * default JSON console logger. Returns the previous logger so tests can
 * save and restore state.
 */
export function configureRuntimeLogger(logger: Logger | null): Logger {
  const previous = runtimeLogger;
  runtimeLogger = logger ?? createConsoleLogger({ base: { runtime: 'lambda' } });
  return previous;
}

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
  /**
   * P-LAMBDA-1: maximum time in milliseconds to wait for in-flight invocations
   * to complete on `SIGTERM` before running the `onShutdown` hook. The Lambda
   * platform's SIGTERM-to-SIGKILL grace window caps the total runway; this
   * value should be set well below it. Defaults to {@link DEFAULT_SHUTDOWN_DRAIN_MS}
   * (5 s).
   */
  shutdownDrainMs?: number;
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
  // P-LAMBDA-5: when bootstrap fails on cold start we still flip coldStart
  // to false (so a successful warm invoke is correctly labelled) and set
  // bootstrapError so the first warm invocation knows the previous
  // bootstrap aborted. The flag is cleared as soon as a bootstrap succeeds.
  let bootstrapError = false;
  let shutdownRegistered = false;
  // P-LAMBDA-1: track in-flight invocations so SIGTERM can await them
  // before running onShutdown.
  const inflight = new Set<Promise<unknown>>();
  const streamingRequested = (config as LambdaRuntimeOptions).streamingHandler === true;
  const shutdownDrainMs =
    typeof (config as LambdaRuntimeOptions).shutdownDrainMs === 'number' &&
    (config as LambdaRuntimeOptions).shutdownDrainMs! >= 0
      ? (config as LambdaRuntimeOptions).shutdownDrainMs!
      : DEFAULT_SHUTDOWN_DRAIN_MS;
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
      try {
        const bootstrapped = await bootstrap(config);
        try {
          await config.hooks?.onInit?.(bootstrapped.ctx);
        } catch (err) {
          await bootstrapped.teardown().catch(() => {});
          throw err;
        }
        cached = bootstrapped;
        bootstrapError = false;
      } catch (err) {
        // P-LAMBDA-5: a failed bootstrap must NOT leave coldStart=true so
        // the first SUCCESSFUL warm invocation is mislabelled. Mark the
        // cold start as consumed and remember the failure so the first
        // recovery invocation can be flagged.
        coldStart = false;
        bootstrapError = true;
        throw err;
      }
    }
    if (!shutdownRegistered) {
      // Always register a SIGTERM handler — even without onShutdown — so we
      // can drain in-flight invocations. The drain is the safety-critical
      // part; the user hook is optional.
      shutdownRegistered = true;
      const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 1500;
      process.once('SIGTERM', () => {
        // P-LAMBDA-1: wait for in-flight invocations first, bounded by the
        // shutdownDrainMs window. Lambda's actual SIGTERM grace caps total
        // runway; we leave the remaining time for the user's onShutdown.
        const drainStart = Date.now();
        const drainPromise = Promise.allSettled([...inflight]).then(() => 'drained' as const);
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const drainTimeout = new Promise<'timeout'>(resolve => {
          drainTimer = setTimeout(() => resolve('timeout'), shutdownDrainMs);
        });
        const fullShutdown = (async () => {
          const outcome = await Promise.race([drainPromise, drainTimeout]);
          if (drainTimer) clearTimeout(drainTimer);
          if (outcome === 'timeout' && inflight.size > 0) {
            runtimeLogger.warn('shutdown-drain-timeout', {
              shutdownDrainMs,
              inflight: inflight.size,
            });
          }
          if (!config.hooks?.onShutdown) return;
          // Use the time remaining within shutdownTimeoutMs (subtract drain
          // elapsed). If the drain already took longer than the hook's
          // timeout budget, give the hook at least 250 ms.
          const remaining = Math.max(250, shutdownTimeoutMs - (Date.now() - drainStart));
          const hookPromise = Promise.resolve()
            .then(() => config.hooks?.onShutdown?.(cached?.ctx as SlingshotContext))
            .catch(err => {
              runtimeLogger.error('onShutdown-hook-threw', {
                phase: 'sigterm',
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              });
            });
          let hookTimer: ReturnType<typeof setTimeout> | undefined;
          const hookTimeout = new Promise<void>(resolve => {
            hookTimer = setTimeout(() => {
              runtimeLogger.warn('onShutdown-hook-timeout', {
                timeoutMs: remaining,
              });
              resolve();
            }, remaining);
          });
          await Promise.race([hookPromise, hookTimeout]);
          if (hookTimer) clearTimeout(hookTimer);
        })();
        void fullShutdown;
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
        // P-LAMBDA-1: track this invocation so SIGTERM can await it.
        const invocation: Promise<unknown> = (async () => {
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
            // P-LAMBDA-5: clear bootstrapError after the first successful
            // recovery invocation so subsequent invocations are not
            // permanently flagged.
            bootstrapError = false;
          }
        })();
        inflight.add(invocation);
        try {
          return await invocation;
        } finally {
          inflight.delete(invocation);
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
      bootstrapError = false;
    },
    // Test-only inspection surface. Not part of the public contract — the
    // shape of these getters is allowed to change without notice.
    _internals: {
      get coldStart(): boolean {
        return coldStart;
      },
      get bootstrapError(): boolean {
        return bootstrapError;
      },
      get inflightCount(): number {
        return inflight.size;
      },
    },
  } as LambdaRuntime & {
    _internals: { coldStart: boolean; bootstrapError: boolean; inflightCount: number };
  };
}

export type { LambdaTriggerKind } from './triggers';
