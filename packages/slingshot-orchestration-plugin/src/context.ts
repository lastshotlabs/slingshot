import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { OrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';

export const ORCHESTRATION_PLUGIN_KEY = 'slingshot-orchestration';

/**
 * Read the orchestration runtime published by `createOrchestrationPlugin()`.
 *
 * Throws when the plugin has not been registered for the current app instance.
 */
export function getOrchestration(ctx: SlingshotContext): OrchestrationRuntime {
  const runtime = ctx.pluginState.get(ORCHESTRATION_PLUGIN_KEY) as OrchestrationRuntime | undefined;
  if (!runtime) {
    throw new OrchestrationError(
      'ADAPTER_ERROR',
      'Orchestration plugin is not registered. Add createOrchestrationPlugin() to your plugins array.',
    );
  }
  return runtime;
}

/**
 * Read the orchestration runtime from plugin state, returning `null` when the plugin
 * is not present.
 */
export function getOrchestrationOrNull(ctx: SlingshotContext): OrchestrationRuntime | null {
  return (
    (ctx.pluginState.get(ORCHESTRATION_PLUGIN_KEY) as OrchestrationRuntime | undefined) ?? null
  );
}
