import type { TracingConfig } from '@config/types/observability';
import { type Tracer, trace } from '@opentelemetry/api';

/**
 * The instrumentation scope name used for all Slingshot-created spans.
 * Consumers see this in their OTel backend as the library/instrumentation name.
 */
const INSTRUMENTATION_SCOPE = '@lastshotlabs/slingshot';

/**
 * Resolve a tracer from the global OTel API.
 *
 * When tracing is disabled or no SDK is registered, `trace.getTracer()`
 * returns a no-op tracer — all span operations become zero-cost no-ops.
 *
 * @param config - Tracing configuration. When `enabled` is false or
 *   undefined, returns the no-op tracer directly.
 * @returns An OTel `Tracer` scoped to the Slingshot instrumentation library.
 */
export function getTracer(config: TracingConfig | undefined): Tracer {
  return trace.getTracer(INSTRUMENTATION_SCOPE, config?.serviceName);
}

/**
 * Check whether tracing is enabled in the given config.
 *
 * Use this to guard span creation in hot paths where even the no-op
 * tracer overhead should be avoided (e.g., per-request attribute
 * resolution). For most instrumentation points, just call `getTracer()`
 * — the no-op tracer is effectively free.
 */
export function isTracingEnabled(config: TracingConfig | undefined): boolean {
  return config?.enabled === true;
}
