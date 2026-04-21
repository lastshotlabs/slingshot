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
import { type LambdaTriggerKind, resolveLambdaTrigger } from './triggers';

type LambdaContextLike = {
  awsRequestId?: string;
};

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
 */
export function createLambdaRuntime(config: FunctionsRuntimeConfig): LambdaRuntime {
  let cached: BootstrapResult | null = null;
  let coldStart = true;
  let shutdownRegistered = false;

  async function ensureBootstrap(): Promise<BootstrapResult> {
    if (!cached) {
      cached = await bootstrap(config);
      await config.hooks?.onInit?.(cached.ctx);
    }
    if (!shutdownRegistered && config.hooks?.onShutdown) {
      shutdownRegistered = true;
      process.once('SIGTERM', () => {
        void Promise.race([
          config.hooks?.onShutdown?.(cached?.ctx as SlingshotContext),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]).catch(() => {});
      });
    }
    return cached;
  }

  return {
    wrap(handler, trigger, opts) {
      const adapter = resolveLambdaTrigger(trigger);
      return async (event: unknown, context: LambdaContextLike) => {
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
          );
        } finally {
          coldStart = false;
        }
      };
    },
    async getContext() {
      return (await ensureBootstrap()).ctx;
    },
    async shutdown() {
      if (!cached) return;
      await config.hooks?.onShutdown?.(cached.ctx);
      await cached.teardown();
      cached = null;
      coldStart = true;
    },
  };
}

export type { LambdaTriggerKind } from './triggers';
