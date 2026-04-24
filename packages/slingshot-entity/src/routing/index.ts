export { applyRouteConfig } from './applyRouteConfig';
export type { RouteConfigDeps } from './applyRouteConfig';
export { buildBareEntityRoutes } from './buildBareEntityRoutes';
export type { BareEntityAdapter } from './buildBareEntityRoutes';
export {
  defineEntityExecutor,
  defineEntityRoute,
  normalizeEntityRouteShape,
  planEntityRoutes,
  scoreEntityRouteSpecificity,
} from './entityRoutePlanning';
export type {
  EntityExtraRoute,
  EntityGeneratedRouteKey,
  EntityRouteExecutionContext,
  EntityRouteExecutor,
  EntityRouteExecutorDefinition,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorBuilderContext,
  EntityRouteExecutorOverrides,
  PlannedEntityRoute,
} from './entityRoutePlanning';
export { evaluateRouteAuth } from './evaluateRouteAuth';
export type { EvaluateRouteAuthDeps, RouteAuthResult } from './evaluateRouteAuth';
export {
  dataScopesFor,
  findScopedFieldInBody,
  normalizeDataScopes,
  resolveDataScopeValue,
  resolveDataScopes,
} from './resolveDataScope';
export type { DataScopeResolution } from './resolveDataScope';
