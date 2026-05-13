import './events';

/**
 * Slingshot-specific integration surface for the portable orchestration runtime.
 */
export { createOrchestrationPackage } from './plugin';
/**
 * Runtime lookup helpers and the plugin name used by Slingshot integrations.
 */
export { getOrchestration, getOrchestrationOrNull, ORCHESTRATION_PLUGIN_KEY } from './context';
/**
 * Provider-owned package contract for cross-package consumers.
 */
export { Orchestration, OrchestrationRuntimeCap } from './public';
/**
 * Create the default Slingshot event sink used by orchestration adapters and workers.
 */
export { createSlingshotEventSink } from './eventSink';
/**
 * Validate the declarative orchestration plugin options accepted by the package
 * factory.
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
