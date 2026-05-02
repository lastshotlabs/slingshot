import type { NamedOpHttpMethod, OperationConfig } from '@lastshotlabs/slingshot-core';
import { getOpParams, opNameToPath } from '../generators/routeHelpers';

/** Resolved HTTP method and path for a named entity operation route. */
export type ResolvedNamedOperationRoute = {
  method: NamedOpHttpMethod;
  path: string;
};

type NamedOperationRouteOverrides = {
  method?: NamedOpHttpMethod;
  path?: string;
};

/** Map an operation kind to its default HTTP method: lookup→GET, exists→HEAD, else POST. */
function defaultNamedOperationMethod(opConfig?: OperationConfig): NamedOpHttpMethod {
  switch (opConfig?.kind) {
    case 'lookup':
      return 'get';
    case 'exists':
      return 'head';
    default:
      return 'post';
  }
}

/** Build a default URL path for an operation: base path from name, with `:param` segments appended for lookup/exists. */
function defaultNamedOperationPath(opName: string, opConfig?: OperationConfig): string {
  const basePath = opNameToPath(opName);
  if (!opConfig) return basePath;

  switch (opConfig.kind) {
    case 'lookup':
    case 'exists': {
      const params = [...new Set(getOpParams(opConfig))];
      if (params.length === 0) return basePath;
      return `${basePath}/${params.map(param => `:${param}`).join('/')}`;
    }
    default:
      return basePath;
  }
}

/**
 * Resolve the HTTP method and path for a named entity operation.
 *
 * Resolution priority: explicit `overrides` → custom operation `http` config → defaults
 * based on operation kind. This cascade allows route config, manifest, and entity
 * definitions to each influence the final route shape.
 *
 * @param opName - The operation name (used to derive the base path).
 * @param opConfig - The operation config, or `undefined` for unresolved operations.
 * @param overrides - Explicit method/path overrides from route configuration.
 * @returns The resolved method and path pair.
 */
export function resolveNamedOperationRoute(
  opName: string,
  opConfig: OperationConfig | undefined,
  overrides: NamedOperationRouteOverrides = {},
): ResolvedNamedOperationRoute {
  const customMethod = opConfig?.kind === 'custom' ? opConfig.http?.method : undefined;
  const customPath = opConfig?.kind === 'custom' ? opConfig.http?.path : undefined;

  return {
    method: overrides.method ?? customMethod ?? defaultNamedOperationMethod(opConfig),
    path: overrides.path ?? customPath ?? defaultNamedOperationPath(opName, opConfig),
  };
}
