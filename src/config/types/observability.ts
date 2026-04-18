/**
 * Configuration for distributed tracing via OpenTelemetry.
 *
 * Slingshot instruments bootstrap phases, request lifecycles, and plugin
 * lifecycle calls with OTel spans. The framework depends on
 * `@opentelemetry/api` only — install an OTel SDK and exporter in your app
 * to collect spans.
 *
 * When `enabled` is false or omitted, no tracer is created and no spans are
 * recorded. The OTel API returns no-op implementations in that case, so there
 * is zero runtime overhead.
 */
export interface TracingConfig {
  /**
   * Enable distributed tracing. Default: false.
   *
   * When true, the framework creates spans for bootstrap phases, HTTP
   * requests, and plugin lifecycle calls. Requires an OTel SDK to be
   * configured in the consuming app for spans to be exported.
   */
  enabled?: boolean;

  /**
   * Service name reported in all spans. Default: the app name from
   * `meta.name`, or `'slingshot-app'` if neither is set.
   *
   * This becomes the `service.name` resource attribute on the tracer.
   */
  serviceName?: string;
}

/**
 * Observability configuration for the Slingshot framework.
 *
 * Groups tracing, and future observability concerns (e.g., profiling)
 * under a single namespace.
 */
export interface ObservabilityConfig {
  /** Distributed tracing via OpenTelemetry. */
  tracing?: TracingConfig;
}
