import './events';

/**
 * Slingshot-specific integration surface for the portable orchestration runtime.
 */
export { createOrchestrationPackage } from './plugin';
/**
 * Runtime lookup helpers used by Slingshot integrations.
 */
export { getOrchestration, getOrchestrationOrNull } from './context';
/**
 * Stable package name (`'slingshot-orchestration-plugin'`). Use this when
 * declaring `dependencies: [...]` on a downstream plugin or package so the
 * orchestration runtime is resolved before your hooks run. For runtime access
 * to the orchestration handle itself, resolve `OrchestrationRuntimeCap` via
 * `ctx.capabilities.require(...)`.
 */
export { ORCHESTRATION_PLUGIN_STATE_KEY } from './context';
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
