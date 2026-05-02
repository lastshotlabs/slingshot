import './events';

/**
 * Slingshot-specific integration surface for the portable orchestration runtime.
 */
export { createOrchestrationPlugin } from './plugin';
/**
 * Health snapshot returned by the orchestration plugin instance.
 */
export type { OrchestrationPluginHealth } from './plugin';
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
/** Typed error classes thrown by the orchestration plugin integration layer. */
export { InvalidResolverResultError } from './errors';
/**
 * Public plugin option types for Slingshot orchestration composition.
 */
export type {
  ConfigurableOrchestrationPluginOptions,
  OrchestrationPluginOptions,
  OrchestrationRequestContext,
  OrchestrationRequestContextResolver,
  OrchestrationRunAuthorizer,
  OrchestrationRunAuthorizationInput,
  ResolvedOrchestrationPluginOptions,
} from './types';
