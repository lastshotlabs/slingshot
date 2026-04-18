import type { ResolvedPageDeclaration } from '../pageDeclarations';
import type { StaticParamSet } from '../types';

interface PageEntityAdapter {
  list(opts: {
    filter?: unknown;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: unknown[]; cursor?: string; nextCursor?: string; hasMore?: boolean }>;
}

const DEFAULT_BATCH_SIZE = 100;

function toParamValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

/**
 * Generate static param sets for entity-driven page declarations.
 *
 * Static list, create-form, and dashboard pages emit a single empty param set
 * when their path contains no dynamic segments. Detail and edit-form pages
 * enumerate entity records and map route param names to record field names.
 *
 * @param declaration - The resolved page declaration to expand.
 * @param adapters - Entity adapters keyed by entity name.
 * @returns Concrete static param sets for the page declaration.
 */
export async function generatePageStaticParams(
  declaration: ResolvedPageDeclaration,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
): Promise<StaticParamSet[]> {
  switch (declaration.declaration.type) {
    case 'entity-list':
    case 'entity-dashboard':
      return declaration.paramNames.length === 0 ? [{}] : [];
    case 'entity-form':
      if (declaration.declaration.operation === 'create') {
        return declaration.paramNames.length === 0 ? [{}] : [];
      }
      return enumerateEntityParams(declaration, adapters);
    case 'entity-detail':
      return enumerateEntityParams(declaration, adapters);
    case 'custom':
      return [];
  }
}

async function enumerateEntityParams(
  declaration: ResolvedPageDeclaration,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
): Promise<StaticParamSet[]> {
  const entityName =
    'entity' in declaration.declaration ? declaration.declaration.entity : undefined;
  if (!entityName) {
    return [];
  }

  const adapter = (adapters as Readonly<Record<string, PageEntityAdapter | undefined>>)[entityName];
  if (!adapter) {
    return [];
  }

  const paramSets: StaticParamSet[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const batch = await adapter.list({
      limit: DEFAULT_BATCH_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const item of batch.items) {
      if (item === null || typeof item !== 'object') continue;

      const params: Record<string, string> = {};
      const record = item as Record<string, unknown>;
      for (const paramName of declaration.paramNames) {
        const value = toParamValue(record[paramName]);
        if (value !== null) {
          params[paramName] = value;
        }
      }

      if (Object.keys(params).length === declaration.paramNames.length) {
        paramSets.push(Object.freeze(params));
      }
    }

    const nextCursor =
      typeof batch.nextCursor === 'string'
        ? batch.nextCursor
        : typeof batch.cursor === 'string'
          ? batch.cursor
          : undefined;

    if (!batch.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return paramSets;
}
