import type { Context, MiddlewareHandler } from 'hono';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationAdapter,
  OrchestrationRuntime,
  Run,
  WorkflowRun,
} from '@lastshotlabs/slingshot-orchestration';

/**
 * Request-scoped orchestration metadata resolved by the HTTP layer before a run is
 * started or authorized.
 */
export interface OrchestrationRequestContext {
  tenantId?: string;
  actorId?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Input passed to custom run-authorization hooks for reads, listing, signals, and
 * cancellations.
 */
export interface OrchestrationRunAuthorizationInput {
  action: 'read' | 'cancel' | 'signal' | 'list';
  context: OrchestrationRequestContext;
  run: Run | WorkflowRun;
  request: Context;
}

/**
 * Hook that maps an HTTP request onto orchestration tenant/actor metadata without
 * coupling the router to a specific identity package.
 */
export type OrchestrationRequestContextResolver = (
  request: Context,
) => OrchestrationRequestContext | Promise<OrchestrationRequestContext>;

/**
 * Hook that decides whether a caller can view or control a specific run.
 */
export type OrchestrationRunAuthorizer = (
  input: OrchestrationRunAuthorizationInput,
) => boolean | Promise<boolean>;

type OrchestrationPluginRouteOptions = {
  routes?: boolean;
  routePrefix?: string;
  routeMiddleware?: MiddlewareHandler[];
  /**
   * Optional middleware stack used to gate `/health` and `/metrics` admin routes.
   * If omitted, admin routes are protected by the same `routeMiddleware` chain.
   * Provide a separate gate (e.g., basic auth, IP allowlist) so ops tooling can
   * authenticate without exposing user-tier credentials to the orchestration API.
   */
  adminAuth?: MiddlewareHandler[];
  resolveRequestContext?: OrchestrationRequestContextResolver;
  authorizeRun?: OrchestrationRunAuthorizer;
  /**
   * Per-request timeout (ms) applied to adapter awaits inside HTTP routes.
   * Adapter calls that exceed the timeout return HTTP 504 with a structured body.
   * Default: 30_000.
   */
  routeTimeoutMs?: number;
};

/**
 * Options for wiring the portable orchestration runtime into a Slingshot app.
 *
 * Pass either a prebuilt `runtime` or a concrete `adapter` plus task/workflow
 * definitions. When `routes` is enabled, `routeMiddleware` must contain at least
 * one guard so the HTTP surface is never mounted unprotected by accident.
 */
export type OrchestrationPluginOptions =
  | {
      runtime: OrchestrationRuntime;
      tasks: AnyResolvedTask[];
      workflows?: AnyResolvedWorkflow[];
      adapter?: never;
    }
  | {
      adapter: OrchestrationAdapter;
      tasks: AnyResolvedTask[];
      workflows?: AnyResolvedWorkflow[];
      runtime?: never;
    };

export type ResolvedOrchestrationPluginOptions = (
  | {
      runtime: OrchestrationRuntime;
      tasks: AnyResolvedTask[];
      workflows?: AnyResolvedWorkflow[];
      adapter?: never;
    }
  | {
      adapter: OrchestrationAdapter;
      tasks: AnyResolvedTask[];
      workflows?: AnyResolvedWorkflow[];
      runtime?: never;
    }
) &
  OrchestrationPluginRouteOptions;

/**
 * Full code-first orchestration plugin options, including optional HTTP route hooks.
 */
export type ConfigurableOrchestrationPluginOptions = OrchestrationPluginOptions &
  OrchestrationPluginRouteOptions;
