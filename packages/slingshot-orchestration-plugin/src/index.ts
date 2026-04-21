import './events';

/**
 * Slingshot-specific integration surface for the portable orchestration runtime.
 */
export { createOrchestrationPlugin } from './plugin';
/**
 * Runtime lookup helpers and the plugin-state key used by Slingshot integrations.
 */
export { getOrchestration, getOrchestrationOrNull, ORCHESTRATION_PLUGIN_KEY } from './context';
/**
 * Create the default Slingshot event sink used by orchestration adapters and workers.
 */
export { createSlingshotEventSink } from './eventSink';
/**
 * Validate manifest and code-first orchestration plugin options.
 */
export { orchestrationPluginConfigSchema } from './validation';
/**
 * Public plugin option types for Slingshot orchestration composition.
 */
export type { OrchestrationPluginOptions } from './types';
