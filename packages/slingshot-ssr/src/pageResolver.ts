import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { PageDeclaration, ResolvedPageDeclaration } from './pageDeclarations';
import type { SsrRouteChain, SsrRouteMatch } from './types';

interface CompiledPagePattern {
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
  readonly isCatchAll: boolean;
  readonly dynamicSegmentCount: number;
}

/**
 * Compile manifest page declarations into a route table.
 *
 * The returned table is sorted by specificity so static routes win over dynamic
 * ones, mirroring the file-system SSR resolver.
 *
 * @param pages - Manifest page declarations keyed by page key.
 * @param entityConfigs - Entity configs keyed by entity name.
 * @returns Frozen route table entries ready for request-time matching.
 */
export function buildPageRouteTable(
  pages: Readonly<Record<string, PageDeclaration>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
): readonly ResolvedPageDeclaration[] {
  const entries = Object.entries(pages).map(([key, declaration]) => {
    const compiled = compilePagePattern(declaration.path);
    const entityName = getDeclarationEntityName(declaration);
    const entityConfig = entityName ? (entityConfigs.get(entityName) ?? null) : null;

    if (entityConfig) {
      validateDeclarationAgainstEntity(declaration, entityConfig, key);
    }

    return {
      key,
      declaration: Object.freeze({ ...declaration }),
      entityConfig,
      pattern: compiled.pattern,
      paramNames: compiled.paramNames,
      _sort: compiled,
    };
  });

  entries.sort((left, right) => {
    if (left._sort.isCatchAll !== right._sort.isCatchAll) {
      return left._sort.isCatchAll ? 1 : -1;
    }
    if (left._sort.dynamicSegmentCount !== right._sort.dynamicSegmentCount) {
      return left._sort.dynamicSegmentCount - right._sort.dynamicSegmentCount;
    }
    return right.declaration.path.length - left.declaration.path.length;
  });

  return Object.freeze(
    entries.map(entry =>
      Object.freeze({
        key: entry.key,
        declaration: entry.declaration,
        entityConfig: entry.entityConfig,
        pattern: entry.pattern,
        paramNames: entry.paramNames,
      }),
    ),
  );
}

/**
 * Resolve a pathname against a compiled page route table.
 *
 * @param pathname - Request pathname.
 * @param routeTable - Compiled page route table.
 * @returns The matched page declaration and extracted params, or `null`.
 */
export function resolvePageDeclaration(
  pathname: string,
  routeTable: readonly ResolvedPageDeclaration[],
): { declaration: ResolvedPageDeclaration; params: Record<string, string> } | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;

  for (const declaration of routeTable) {
    const match = declaration.pattern.exec(normalized);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (const name of declaration.paramNames) {
      const value = match.groups?.[name];
      if (value !== undefined) {
        const decoded = safeDecodeParam(value);
        if (decoded === null) return null;
        params[name] = decoded;
      }
    }

    return { declaration, params };
  }

  return null;
}

/**
 * Build a synthetic route chain for a manifest-backed page declaration.
 *
 * @param declaration - Resolved page declaration.
 * @param params - Extracted route params.
 * @param url - Request URL.
 * @param query - Parsed query string.
 * @returns A synthetic route chain whose page match carries `pageDeclaration`.
 */
export function buildPageChain(
  declaration: ResolvedPageDeclaration,
  params: Record<string, string>,
  url: URL,
  query: Record<string, string>,
): SsrRouteChain {
  const match: SsrRouteMatch = Object.freeze({
    filePath: `__page:${declaration.key}`,
    metaFilePath: null,
    params: Object.freeze({ ...params }),
    query: Object.freeze({ ...query }),
    url,
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
    pageDeclaration: declaration,
  });

  return Object.freeze({
    layouts: Object.freeze([]),
    page: match,
    slots: undefined,
    intercepted: undefined,
    middlewareFilePath: null,
  });
}

function getDeclarationEntityName(declaration: PageDeclaration): string | null {
  switch (declaration.type) {
    case 'entity-list':
    case 'entity-detail':
    case 'entity-form':
      return declaration.entity;
    case 'entity-dashboard':
    case 'custom':
      return null;
  }
}

function validateDeclarationAgainstEntity(
  declaration: PageDeclaration,
  entityConfig: ResolvedEntityConfig,
  pageKey: string,
): void {
  const fieldNames = new Set(Object.keys(entityConfig.fields));
  for (const fieldName of getReferencedFields(declaration)) {
    if (!fieldNames.has(fieldName)) {
      throw new Error(
        `[slingshot-ssr] Page "${pageKey}" references field "${fieldName}" which does not exist on entity "${entityConfig.name}".`,
      );
    }
  }
}

function getReferencedFields(declaration: PageDeclaration): string[] {
  switch (declaration.type) {
    case 'entity-list':
      return [
        ...declaration.fields,
        ...(declaration.defaultSort ? [declaration.defaultSort.field] : []),
        ...(declaration.filters?.map(filter => filter.field) ?? []),
      ];
    case 'entity-detail':
      return [
        ...(declaration.fields ?? []),
        ...(declaration.sections?.flatMap(section => section.fields) ?? []),
        ...(declaration.related?.flatMap(section => [section.foreignKey, ...section.fields]) ?? []),
      ];
    case 'entity-form':
      return [...declaration.fields, ...Object.keys(declaration.fieldConfig ?? {})];
    case 'entity-dashboard':
      return [
        ...declaration.stats.flatMap(stat => (stat.field ? [stat.field] : [])),
        ...(declaration.activity?.fields ?? []),
        ...(declaration.activity?.sortField ? [declaration.activity.sortField] : []),
        ...(declaration.chart
          ? [declaration.chart.categoryField, declaration.chart.valueField]
          : []),
      ];
    case 'custom':
      return [];
  }
}

function compilePagePattern(path: string): CompiledPagePattern {
  const segments = path.split('/');
  const patternParts: string[] = [];
  const paramNames: string[] = [];
  let isCatchAll = false;
  let dynamicSegmentCount = 0;

  for (const segment of segments) {
    if (segment === '') {
      patternParts.push('');
      continue;
    }

    const catchAllMatch = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (catchAllMatch) {
      const name = catchAllMatch[1];
      validateParamName(name, path);
      paramNames.push(name);
      dynamicSegmentCount += 1;
      isCatchAll = true;
      patternParts.push(`(?<${name}>.+)`);
      continue;
    }

    const dynamicMatch = /^\[([^\]]+)\]$/.exec(segment);
    if (dynamicMatch) {
      const name = dynamicMatch[1];
      validateParamName(name, path);
      paramNames.push(name);
      dynamicSegmentCount += 1;
      patternParts.push(`(?<${name}>[^/]+)`);
      continue;
    }

    patternParts.push(escapeRegex(segment));
  }

  const pattern = new RegExp(`^${patternParts.join('/') || '/'}$`);
  return Object.freeze({
    pattern,
    paramNames: Object.freeze(paramNames),
    isCatchAll,
    dynamicSegmentCount,
  });
}

function validateParamName(name: string, path: string): void {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    throw new Error(`[slingshot-ssr] Invalid page param "${name}" in path "${path}".`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDecodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
