import type { NamedOpHttpMethod, OperationConfig } from '@lastshotlabs/slingshot-core';
import { getOpParams, opNameToPath } from '../generators/routeHelpers';

export type ResolvedNamedOperationRoute = {
  method: NamedOpHttpMethod;
  path: string;
};

type NamedOperationRouteOverrides = {
  method?: NamedOpHttpMethod;
  path?: string;
};

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
