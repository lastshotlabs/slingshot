import './events';

/**
 * Slingshot-specific integration surface for the portable orchestration runtime.
 */
export { createOrchestrationPlugin } from './plugin';
export { getOrchestration, getOrchestrationOrNull, ORCHESTRATION_PLUGIN_KEY } from './context';
export { createSlingshotEventSink } from './eventSink';
export type { OrchestrationPluginOptions } from './types';
