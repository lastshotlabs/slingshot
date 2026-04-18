/**
 * Operation dispatch — routes op configs to their generators.
 *
 * Uses a switch on the discriminated union `kind` field for type-safe
 * narrowing. No casts needed — TypeScript narrows each case automatically.
 */
import type { ResolvedEntityConfig } from '../types/entity';
import type { OperationConfig } from '../types/operations';
import type { Backend } from './filter';
import { generateOperationSignature } from './operationSignature';
import { generateAggregate } from './operations/aggregate';
import { generateArrayPull } from './operations/arrayPull';
import { generateArrayPush } from './operations/arrayPush';
import { generateArraySet } from './operations/arraySet';
import { generateBatch } from './operations/batch';
import { generateCollection } from './operations/collection';
import { generateComputedAggregate } from './operations/computedAggregate';
import { generateConsume } from './operations/consume';
import { generateDerive } from './operations/derive';
import { generateExists } from './operations/exists';
import { generateFieldUpdate } from './operations/fieldUpdate';
import { generateIncrement } from './operations/increment';
import { generateLookup } from './operations/lookup';
import { generateSearch } from './operations/search';
import { generateTransition } from './operations/transition';
import { generateUpsert } from './operations/upsert';

function dispatchOp(
  opName: string,
  op: OperationConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  switch (op.kind) {
    case 'lookup':
      return generateLookup(opName, op, entity, backend);
    case 'exists':
      return generateExists(opName, op, entity, backend);
    case 'transition':
      return generateTransition(opName, op, entity, backend);
    case 'fieldUpdate':
      return generateFieldUpdate(opName, op, entity, backend);
    case 'aggregate':
      return generateAggregate(opName, op, entity, backend);
    case 'computedAggregate':
      return generateComputedAggregate(opName, op, entity, backend);
    case 'batch':
      return generateBatch(opName, op, entity, backend);
    case 'upsert':
      return generateUpsert(opName, op, entity, backend);
    case 'search':
      return generateSearch(opName, op, entity, backend);
    case 'collection':
      return generateCollection(opName, op, entity, backend);
    case 'consume':
      return generateConsume(opName, op, entity, backend);
    case 'derive':
      return generateDerive(opName, op, entity, backend);
    case 'transaction':
      return `    // ${opName}: transaction operation — wire at composite adapter level`;
    case 'pipe':
      return `    // ${opName}: pipe operation — wire after all ops are attached`;
    case 'arrayPush':
      return generateArrayPush(opName, op, entity, backend);
    case 'arrayPull':
      return generateArrayPull(opName, op, entity, backend);
    case 'arraySet':
      return generateArraySet(opName, op, entity, backend);
    case 'increment':
      return generateIncrement(opName, op, entity, backend);
    case 'custom':
      return `    // ${opName}: custom operation (user-provided)`;
  }
}

/**
 * Generate all operation method bodies for a specific backend.
 *
 * Iterates over `operations` and dispatches each to its backend-specific
 * generator via `dispatchOp()`. The returned strings are the method body
 * implementations (not signatures) that are interpolated inside the adapter
 * factory's return object literal.
 *
 * @param operations - Record mapping operation names to their `OperationConfig`.
 * @param entity - The resolved entity config (used for field type resolution,
 *   primary key info, and soft-delete config).
 * @param backend - Which backend to generate code for. One of `'memory'`,
 *   `'sqlite'`, `'postgres'`, `'mongo'`, or `'redis'`.
 * @returns An array of TypeScript source strings, one per operation, in the
 *   same order as `Object.entries(operations)`.
 *
 * @example
 * ```ts
 * import { generateOperationMethods } from '@lastshotlabs/slingshot-entity';
 *
 * const methods = generateOperationMethods(operations, config, 'sqlite');
 * // Splice into the adapter factory return object
 * ```
 */
export function generateOperationMethods(
  operations: Record<string, OperationConfig>,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string[] {
  return Object.entries(operations).map(([opName, opConfig]) =>
    dispatchOp(opName, opConfig, entity, backend),
  );
}

/**
 * Generate operation method signatures for the adapter interface.
 *
 * Iterates over `operations` and delegates each to
 * `generateOperationSignature()`. The returned strings are TypeScript interface
 * method signature lines (e.g. `"  bySlug(slug: string): Promise<Message | null>;"`)
 * that are interpolated inside the `{Name}Adapter` interface body.
 *
 * @param operations - Record mapping operation names to their `OperationConfig`.
 * @param entity - The resolved entity config used to infer parameter types from
 *   field definitions.
 * @returns An array of TypeScript source strings, one per operation, in the
 *   same order as `Object.entries(operations)`.
 *
 * @example
 * ```ts
 * import { generateOperationSignatures } from '@lastshotlabs/slingshot-entity';
 *
 * const sigs = generateOperationSignatures(operations, config);
 * const adapter = generateAdapter(config, sigs);
 * ```
 */
export function generateOperationSignatures(
  operations: Record<string, OperationConfig>,
  entity: ResolvedEntityConfig,
): string[] {
  return Object.entries(operations).map(([opName, opConfig]) =>
    generateOperationSignature(opName, opConfig, entity),
  );
}
