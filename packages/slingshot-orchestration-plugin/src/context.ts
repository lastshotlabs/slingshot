import { definePluginStateKey, readPluginState } from '@lastshotlabs/slingshot-core';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { OrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';

/**
 * Plugin name used for registration, dependency declarations, and event ownership.
 */
export const ORCHESTRATION_PLUGIN_KEY = 'slingshot-orchestration';

/**
 * Typed plugin-state key for the orchestration runtime slot.
 */
export const ORCHESTRATION_RUNTIME_KEY = definePluginStateKey<OrchestrationRuntime>(
  ORCHESTRATION_PLUGIN_KEY,
);

/**
 * Read the orchestration runtime published by `createOrchestrationPlugin()`.
 *
 * Throws when the plugin has not been registered for the current app instance.
 */
export function getOrchestration(ctx: SlingshotContext): OrchestrationRuntime {
  const runtime = readPluginState(ctx, ORCHESTRATION_RUNTIME_KEY);
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
  return readPluginState(ctx, ORCHESTRATION_RUNTIME_KEY) ?? null;
}
