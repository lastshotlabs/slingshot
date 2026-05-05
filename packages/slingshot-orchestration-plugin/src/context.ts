import { resolveCapabilityValue } from '@lastshotlabs/slingshot-core';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { OrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationRuntimeCap } from './public';

/**
 * Plugin name used for registration, dependency declarations, and event ownership.
 */
export const ORCHESTRATION_PLUGIN_KEY = 'slingshot-orchestration';

/**
 * Read the orchestration runtime published by `createOrchestrationPlugin()`.
 *
 * Resolves through the typed `OrchestrationRuntimeCap` contract capability. Throws
 * when the plugin has not been registered for the current app instance.
 *
 * Equivalent to `ctx.capabilities.require(OrchestrationRuntimeCap)` — the contract
 * handle is the canonical way to consume this surface; this helper exists for
 * call-site ergonomics and back-compat with documented examples.
 */
export function getOrchestration(ctx: SlingshotContext): OrchestrationRuntime {
  const runtime = resolveCapabilityValue(ctx, OrchestrationRuntimeCap);
  if (!runtime) {
    throw new OrchestrationError(
      'ADAPTER_ERROR',
      'Orchestration plugin is not registered. Add createOrchestrationPlugin() to your plugins array.',
    );
  }
  return runtime;
}

/**
 * Read the orchestration runtime through the typed contract, returning `null` when the
 * plugin is not present.
 */
export function getOrchestrationOrNull(ctx: SlingshotContext): OrchestrationRuntime | null {
  return resolveCapabilityValue(ctx, OrchestrationRuntimeCap) ?? null;
}
