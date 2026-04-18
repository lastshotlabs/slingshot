/**
 * Route generation helpers — shared utilities for building route source code.
 */
import type { OperationConfig } from '@lastshotlabs/slingshot-core';
import { extractMatchParams, extractParams } from './filter';

/**
 * Convert an entity name to a URL-friendly kebab-case plural path segment.
 *
 * Converts PascalCase word boundaries to hyphens, lower-cases the result, then
 * applies English pluralisation rules to the last word segment.
 *
 * @param name - PascalCase entity name (e.g. `'Message'`, `'LedgerItem'`, `'Status'`).
 * @returns The kebab-case plural URL segment (e.g. `'messages'`, `'ledger-items'`, `'statuses'`).
 *
 * @example
 * ```ts
 * entityToPath('Message');    // 'messages'
 * entityToPath('LedgerItem'); // 'ledger-items'
 * entityToPath('Status');     // 'statuses'
 * entityToPath('Category');   // 'categories'
 * ```
 */
export function entityToPath(name: string): string {
  const kebab = name
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
  const parts = kebab.split('-');
  parts[parts.length - 1] = pluralizeSegment(parts[parts.length - 1]);
  return parts.join('-');
}

/**
 * Pluralise a single lowercase word segment using common English rules.
 *
 * - Sibilant endings (`s`, `ss`, `sh`, `ch`, `x`, `z`) → append `es`
 * - Consonant + `y` ending → replace `y` with `ies`
 * - Everything else → append `s`
 */
function pluralizeSegment(word: string): string {
  if (/(s|ss|sh|ch|x|z)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

/**
 * Return the entity name unchanged for use as an OpenAPI tag label.
 *
 * The entity name is already PascalCase, which is the desired format for tags
 * and schema references. This function exists as an explicit named step in the
 * generator pipeline so that tag derivation is expressed as data flow rather
 * than an implicit convention.
 *
 * @param name - PascalCase entity name.
 * @returns The entity name as-is.
 */
export function entityTag(name: string): string {
  return name;
}

/**
 * Convert a camelCase operation name to a kebab-case URL path segment.
 *
 * Inserts hyphens before uppercase letters and lower-cases the result.
 *
 * @param name - camelCase operation name (e.g. `'markDelivered'`).
 * @returns kebab-case path segment (e.g. `'mark-delivered'`).
 *
 * @example
 * ```ts
 * opNameToPath('markDelivered'); // 'mark-delivered'
 * opNameToPath('bySlug');        // 'by-slug'
 * ```
 */
export function opNameToPath(name: string): string {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Return the camelCase variable name for an entity.
 *
 * Lowercases the first character of the PascalCase entity name. Used when
 * emitting local variable names for entity instances in generated code.
 *
 * @param name - PascalCase entity name (e.g. `'Message'`, `'LedgerItem'`).
 * @returns camelCase variable name (e.g. `'message'`, `'ledgerItem'`).
 */
export function entityVar(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Return the Zod schema variable name references for an entity.
 *
 * Provides a centralized place for the naming convention used in generated
 * code so that `generateRoutes()` and other generators reference the same
 * variable names as `generateSchemas()` produces.
 *
 * @param name - PascalCase entity name.
 * @returns An object with the variable names for `entity`, `create`, `update`,
 *   `listOptions`, and `paginated` schemas.
 *
 * @example
 * ```ts
 * const s = schemaNames('Message');
 * // s.entity       = 'messageSchema'
 * // s.create       = 'createMessageSchema'
 * // s.update       = 'updateMessageSchema'
 * // s.listOptions  = 'listMessageOptionsSchema'
 * // s.paginated    = 'paginatedMessageSchema'
 * ```
 */
export function schemaNames(name: string): {
  entity: string;
  create: string;
  update: string;
  listOptions: string;
  paginated: string;
} {
  const v = entityVar(name);
  return {
    entity: `${v}Schema`,
    create: `create${name}Schema`,
    update: `update${name}Schema`,
    listOptions: `list${name}OptionsSchema`,
    paginated: `paginated${name}Schema`,
  };
}

/**
 * Extract the URL/body parameter names that an operation requires.
 *
 * Dispatches on `op.kind` and delegates to the appropriate filter/match
 * extraction helper. The returned array is used by `generateOpRoute()` to
 * build the Zod parameter schema and the handler function argument list.
 *
 * @param op - The discriminated-union operation config.
 * @returns An array of parameter name strings (e.g. `['userId', 'containerId']`).
 *   Returns an empty array for operations with no URL/body parameters
 *   (`search`, `upsert`, `derive`, `collection`, `transaction`, `pipe`,
 *   `custom`).
 *
 * @example
 * ```ts
 * import { getOpParams } from '@lastshotlabs/slingshot-entity';
 *
 * getOpParams({ kind: 'lookup', fields: { userId: 'param:userId' }, returns: 'one' });
 * // ['userId']
 * ```
 */
export function getOpParams(op: OperationConfig): string[] {
  switch (op.kind) {
    case 'lookup':
    case 'exists':
      return extractMatchParams(op.fields);
    case 'transition':
      return extractMatchParams(op.match);
    case 'fieldUpdate':
      return extractMatchParams(op.match);
    case 'batch':
      return extractParams(op.filter);
    case 'consume':
      return extractParams(op.filter);
    case 'aggregate':
      return op.filter ? extractParams(op.filter) : [];
    case 'search':
      return [];
    case 'upsert':
      return [];
    case 'derive':
      return [];
    case 'collection':
      return [];
    case 'computedAggregate':
      return [...extractParams(op.sourceFilter), ...extractMatchParams(op.targetMatch)];
    case 'transaction':
      return [];
    case 'pipe':
      return [];
    case 'arrayPush':
    case 'arrayPull':
    case 'arraySet':
    case 'increment':
      return [];
    case 'custom':
      return [];
  }
}
