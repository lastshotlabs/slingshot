import type { MiddlewareHandler } from 'hono';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationAdapter,
  OrchestrationRuntime,
} from '@lastshotlabs/slingshot-orchestration';

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
      routes?: boolean;
      routePrefix?: string;
      routeMiddleware?: MiddlewareHandler[];
    }
  | {
      adapter: OrchestrationAdapter;
      tasks: AnyResolvedTask[];
      workflows?: AnyResolvedWorkflow[];
      runtime?: never;
      routes?: boolean;
      routePrefix?: string;
      routeMiddleware?: MiddlewareHandler[];
    };
