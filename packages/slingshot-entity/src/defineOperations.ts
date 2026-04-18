/**
 * Operations definition entry point — dev-time only.
 *
 * Validates operation configs using Zod schema against entity field names.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { ResolvedOperations } from './types';
import { validateOperations } from './validation';

/**
 * Declare and validate operations for an entity.
 *
 * Operations describe business-logic queries and mutations beyond basic CRUD.
 * This function:
 * 1. Validates that all field references in operation configs point to real
 *    fields on the entity (e.g. `transition.field`, `fieldUpdate.set`,
 *    `search.fields`).
 * 2. Deep-freezes the resulting operations object (CLAUDE.md rule 12).
 *
 * @param entityConfig - The resolved entity config produced by `defineEntity()`.
 * @param operations - A record of named operation configs built with `op.*()`.
 * @returns A `ResolvedOperations` object that pairs the entity config with the
 *   frozen operations map.
 *
 * @throws {Error} When field references are invalid, with a structured message
 *   listing every invalid path.
 *
 * @example
 * ```ts
 * import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 *
 * export const MessageOps = defineOperations(Message, {
 *   byRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
 *   publish: op.transition({
 *     field: 'status',
 *     from: 'draft',
 *     to: 'published',
 *     match: { id: 'param:id' },
 *   }),
 * });
 * ```
 */
export function defineOperations<Ops extends Record<string, OperationConfig>>(
  entityConfig: ResolvedEntityConfig,
  operations: Ops,
): ResolvedOperations<Ops> {
  const fieldNames = Object.keys(entityConfig.fields);
  const result = validateOperations(operations, fieldNames);

  if (!result.success && result.errors) {
    const issues = result.errors.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[defineOperations:${entityConfig.name}] Validation failed:\n${issues}`);
  }

  // Rule 12: freeze at the boundary. Consumers get immutable operations.
  deepFreezeOps(operations);
  return { entityConfig, operations };
}

function deepFreezeOps(obj: object): void {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreezeOps(value as object);
    }
  }
}
