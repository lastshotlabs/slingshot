/**
 * Operation signature generator — produces TypeScript method signatures
 * for the adapter interface from operation configs.
 *
 * Pure function: OperationConfig → method signature string.
 */
import { tsType } from '../lib/naming';
import type { ResolvedEntityConfig } from '../types/entity';
import type { CollectionOpConfig, OperationConfig } from '../types/operations';
import { extractMatchParams, extractParams } from './filter';

/**
 * Return the TypeScript entity type name for use in generated signatures.
 *
 * @param config - The resolved entity configuration.
 * @returns The entity name string (e.g. `'Message'`, `'User'`).
 */
function entityName(config: ResolvedEntityConfig): string {
  return config.name;
}

/**
 * Resolve the TypeScript type for a single operation parameter.
 *
 * @param paramName - The parameter name as extracted from a `param:x` reference
 *   (e.g. `'id'`, `'slug'`, `'tenantId'`).
 * @param entity - The resolved entity config whose field definitions are
 *   consulted first.
 * @returns The TypeScript type string for the parameter (e.g. `'string'`,
 *   `'number'`).
 *
 * @remarks
 * Resolution order:
 * 1. If the param name matches an entity field name exactly, the field's
 *    TypeScript type is returned via `tsType()`.
 * 2. If the param name ends with `'Id'` or equals `'id'`, `'string'` is
 *    returned as a conventional fallback.
 * 3. Otherwise `'string'` is returned as the default.
 */
function paramType(paramName: string, entity: ResolvedEntityConfig): string {
  // Try to infer type from entity fields
  const field = (entity.fields as Record<string, (typeof entity.fields)[string] | undefined>)[
    paramName
  ];
  if (field) {
    return tsType(field);
  }
  // Common parameter patterns
  if (paramName.endsWith('Id') || paramName === 'id') return 'string';
  return 'string';
}

/**
 * Build a TypeScript parameter list string from a list of parameter names.
 *
 * Each parameter is resolved to its TypeScript type via `paramType()` and the
 * results are joined into a comma-separated string suitable for embedding in a
 * method signature.
 *
 * @param params - Ordered array of parameter names (without the `'param:'`
 *   prefix), e.g. `['id', 'tenantId']`.
 * @param entity - The resolved entity config used to resolve each parameter's
 *   type.
 * @returns A string like `'id: string, tenantId: string'`, or `''` when
 *   `params` is empty.
 */
function buildParamList(params: string[], entity: ResolvedEntityConfig): string {
  return params.map(p => `${p}: ${paramType(p, entity)}`).join(', ');
}

/**
 * Generate the TypeScript method signature for a single operation.
 *
 * Dispatches on `op.kind` to produce the correct parameter list and return type
 * for the operation. Parameter types are inferred from entity field definitions
 * when possible, falling back to `string` for unknown names and common patterns
 * (e.g. fields ending in `'Id'`).
 *
 * The returned string is a single interface method signature line, indented with
 * two spaces, ready to be embedded inside a `{Name}Adapter` interface body. For
 * `collection` operations, multiple lines are returned (one per sub-operation)
 * joined by newlines.
 *
 * @param opName - The operation name as it appears in the entity config (e.g.
 *   `'bySlug'`, `'publish'`).
 * @param op - The discriminated-union operation config.
 * @param entity - The resolved entity config used to resolve parameter types
 *   from field definitions.
 * @returns A TypeScript interface method signature string (or multiple lines
 *   joined by `'\n'` for `collection` operations).
 *
 * @remarks
 * - `transaction` and `pipe` operations are emitted as comments because they are
 *   wired at the composite adapter level, not on single-entity adapters.
 * - `custom` operations are emitted as comments because their signatures are
 *   user-provided.
 *
 * @example
 * ```ts
 * import { generateOperationSignature } from '@lastshotlabs/slingshot-entity';
 *
 * const sig = generateOperationSignature('bySlug', { kind: 'lookup', fields: { slug: 'param:slug' }, returns: 'one' }, config);
 * // '  bySlug(slug: string): Promise<Message | null>;'
 * ```
 */
export function generateOperationSignature(
  opName: string,
  op: OperationConfig,
  entity: ResolvedEntityConfig,
): string {
  const name = entityName(entity);

  switch (op.kind) {
    case 'lookup': {
      const params = extractMatchParams(op.fields);
      const paramList = buildParamList(params, entity);
      if (op.returns === 'one') {
        return `  ${opName}(${paramList}): Promise<${name} | null>;`;
      }
      return `  ${opName}(${paramList}, opts?: ListOptions): Promise<PaginatedResult<${name}>>;`;
    }

    case 'exists': {
      const params = extractMatchParams(op.fields);
      const paramList = buildParamList(params, entity);
      return `  ${opName}(${paramList}): Promise<boolean>;`;
    }

    case 'transition': {
      const params = extractMatchParams(op.match);
      const setParams = op.set
        ? Object.values(op.set)
            .filter((v): v is string => typeof v === 'string' && v.startsWith('param:'))
            .map(v => v.slice(6))
        : [];
      const allParams = [...new Set([...params, ...setParams])];
      const paramList = buildParamList(allParams, entity);
      const returnType = op.returns === 'boolean' ? 'boolean' : `${name} | null`;
      return `  ${opName}(${paramList}): Promise<${returnType}>;`;
    }

    case 'fieldUpdate': {
      const matchParams = extractMatchParams(op.match);
      const inputFields = op.set.map(f => {
        const field = (entity.fields as Record<string, (typeof entity.fields)[string] | undefined>)[
          f
        ];
        const type = field ? tsType(field) : 'unknown';
        const optional = op.partial ? '?' : '';
        return `${f}${optional}: ${type}${op.nullable ? ' | null' : ''}`;
      });
      const matchParamList = buildParamList(matchParams, entity);
      return `  ${opName}(${matchParamList}, input: { ${inputFields.join('; ')} }): Promise<${name}>;`;
    }

    case 'aggregate': {
      const params = op.filter ? extractParams(op.filter) : [];
      const paramList = buildParamList(params, entity);
      const computeFields = Object.keys(op.compute).map(k => `${k}: number`);
      if (op.groupBy) {
        const groupField = typeof op.groupBy === 'string' ? op.groupBy : op.groupBy.field;
        return `  ${opName}(${paramList}): Promise<Array<{ ${groupField}: string; ${computeFields.join('; ')} }>>;`;
      }
      return `  ${opName}(${paramList}): Promise<{ ${computeFields.join('; ')} }>;`;
    }

    case 'computedAggregate': {
      const params = extractParams(op.sourceFilter);
      const targetParams = extractMatchParams(op.targetMatch);
      const allParams = [...new Set([...params, ...targetParams])];
      const paramList = buildParamList(allParams, entity);
      return `  ${opName}(${paramList}): Promise<void>;`;
    }

    case 'batch': {
      const params = extractParams(op.filter);
      const paramList = buildParamList(params, entity);
      const returnType = op.returns === 'count' ? 'number' : 'void';
      return `  ${opName}(${paramList}): Promise<${returnType}>;`;
    }

    case 'upsert': {
      const inputFields = [...op.match, ...op.set].map(f => {
        const field = (entity.fields as Record<string, (typeof entity.fields)[string] | undefined>)[
          f
        ];
        const type = field ? tsType(field) : 'unknown';
        const isInSet = op.set.includes(f);
        return `${f}${isInSet ? '?' : ''}: ${type}`;
      });
      if (op.returns !== 'entity' && op.returns?.created) {
        return `  ${opName}(input: { ${inputFields.join('; ')} }): Promise<{ entity: ${name}; created: boolean }>;`;
      }
      return `  ${opName}(input: { ${inputFields.join('; ')} }): Promise<${name}>;`;
    }

    case 'search': {
      if (op.paginate) {
        return `  ${opName}(query: string, filterParams?: Record<string, unknown>, limit?: number, cursor?: string): Promise<PaginatedResult<${name}>>;`;
      }
      return `  ${opName}(query: string, filterParams?: Record<string, unknown>, limit?: number): Promise<${name}[]>;`;
    }

    case 'collection': {
      return generateCollectionSignatures(opName, op, entity);
    }

    case 'consume': {
      const params = extractParams(op.filter);
      const paramList = buildParamList(params, entity);
      const returnType = op.returns === 'boolean' ? 'boolean' : `${name} | null`;
      return `  ${opName}(${paramList}): Promise<${returnType}>;`;
    }

    case 'derive': {
      // Collect all params from all sources
      const params: string[] = [];
      for (const source of op.sources) {
        for (const v of Object.values(source.where)) {
          if (typeof v === 'string' && v.startsWith('param:')) {
            params.push(v.slice(6));
          }
        }
      }
      const uniqueParams = [...new Set(params)];
      const paramList = buildParamList(uniqueParams, entity);
      return `  ${opName}(${paramList}): Promise<unknown[]>;`;
    }

    case 'transaction':
    case 'pipe':
      // Transaction/pipe are composite-level — not on single-entity adapters
      return `  // ${opName}: ${op.kind} — wired at composite adapter level, not here`;

    case 'arrayPush':
      return `  ${opName}(id: string, value: unknown): Promise<${name}>;`;

    case 'arrayPull':
      return `  ${opName}(id: string, value: unknown): Promise<${name}>;`;

    case 'arraySet':
      return `  ${opName}(id: string, value: unknown[]): Promise<${name}>;`;

    case 'increment':
      return `  ${opName}(id: string, by?: number): Promise<${name}>;`;

    case 'custom':
      // Custom ops define their own signatures — skip in the generic generator
      return `  // ${opName}: custom operation (signature provided by user)`;
  }
}

/**
 * Generate TypeScript method signatures for a `collection` operation.
 *
 * A single `collection` op produces up to five method signatures — one for each
 * entry in `op.operations` (`'list'`, `'add'`, `'remove'`, `'update'`,
 * `'set'`). Each method is named `{opName}{Op}` (e.g. `tagsList`, `tagsAdd`).
 *
 * @param opName - The collection operation name from the entity config (e.g.
 *   `'tags'`, `'attachments'`).
 * @param op - The `CollectionOpConfig` describing the parent key, item fields,
 *   identify-by field, and the subset of operations to generate.
 * @param entity - The resolved entity config used to resolve the parent key's
 *   type.
 * @returns A newline-joined string of interface method signature lines, one
 *   per entry in `op.operations`.
 */
function generateCollectionSignatures(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
): string {
  const parentType = paramType(op.parentKey, entity);
  const itemFields = Object.entries(op.itemFields)
    .map(([n, d]) => `${n}: ${tsType(d)}`)
    .join('; ');
  const itemType = `{ ${itemFields} }`;
  const identifyByField = op.identifyBy
    ? (op.itemFields as Record<string, (typeof op.itemFields)[string] | undefined>)[op.identifyBy]
    : undefined;
  const identifyType = identifyByField ? tsType(identifyByField) : 'string';

  const sigs: string[] = [];

  for (const operation of op.operations) {
    switch (operation) {
      case 'list':
        sigs.push(`  ${opName}List(${op.parentKey}: ${parentType}): Promise<Array<${itemType}>>;`);
        break;
      case 'add':
        sigs.push(
          `  ${opName}Add(${op.parentKey}: ${parentType}, item: ${itemType}): Promise<${itemType}>;`,
        );
        break;
      case 'remove':
        sigs.push(
          `  ${opName}Remove(${op.parentKey}: ${parentType}, ${op.identifyBy ?? 'id'}: ${identifyType}): Promise<void>;`,
        );
        break;
      case 'update':
        sigs.push(
          `  ${opName}Update(${op.parentKey}: ${parentType}, ${op.identifyBy ?? 'id'}: ${identifyType}, updates: Partial<${itemType}>): Promise<${itemType}>;`,
        );
        break;
      case 'set':
        sigs.push(
          `  ${opName}Set(${op.parentKey}: ${parentType}, items: Array<${itemType}>): Promise<void>;`,
        );
        break;
    }
  }

  return sigs.join('\n');
}
