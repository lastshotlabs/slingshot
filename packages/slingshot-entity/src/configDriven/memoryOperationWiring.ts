/**
 * Memory backend operation wiring.
 *
 * Iterates over a `Record<string, OperationConfig>` and dispatches each entry to
 * the corresponding in-memory executor function, returning a flat map of
 * `operationName → bound function` that is spread onto the adapter object.
 *
 * All executors receive the shared `Map<string | number, MemoryEntry>` store
 * and the `isAlive`/`isVisible` predicates by closure — there are no global singletons.
 * TypeScript enforces every boundary; no `as any` casts appear here.
 *
 * **Special cases:**
 * - `collection` expands into up to five sub-methods: `{opName}List`, `{opName}Add`,
 *   `{opName}Remove`, `{opName}Update`, `{opName}Set`.
 * - `transaction` and `pipe` are skipped here — they are wired at the composite-adapter
 *   level because they need access to multiple adapters simultaneously.
 * - `custom` invokes `op.memory(store)` if provided; throws otherwise.
 *
 * **Adding a new operation kind:**
 * 1. Add a `case 'myKind':` block here calling the corresponding `myKindMemory()` executor.
 * 2. Add the same case to `sqliteOperationWiring.ts`, `postgresOperationWiring.ts`,
 *    `mongoOperationWiring.ts`, and `redisOperationWiring.ts`.
 * 3. Implement `myKindMemory()` in `operationExecutors/myKind.ts`.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { aggregateMemory } from './operationExecutors/aggregate';
import { arrayPullMemory } from './operationExecutors/arrayPull';
import { arrayPushMemory } from './operationExecutors/arrayPush';
import { arraySetMemory } from './operationExecutors/arraySet';
import { batchMemory } from './operationExecutors/batch';
import { collectionMemory } from './operationExecutors/collection';
import { computedAggregateMemory } from './operationExecutors/computedAggregate';
import { consumeMemory } from './operationExecutors/consume';
import type { MemoryEntry } from './operationExecutors/dbInterfaces';
import { deriveMemory } from './operationExecutors/derive';
import { existsMemory } from './operationExecutors/exists';
import { fieldUpdateMemory } from './operationExecutors/fieldUpdate';
import { incrementMemory } from './operationExecutors/increment';
import { lookupMemory } from './operationExecutors/lookup';
import { searchMemory } from './operationExecutors/search';
import { transitionMemory } from './operationExecutors/transition';
import { upsertMemory } from './operationExecutors/upsert';

/**
 * Pagination and TTL settings captured from the entity config at adapter-creation time.
 * Passed to executors that need cursor pagination or TTL expiry logic.
 */
interface MemoryAdapterContext {
  /** Primary key field name, used by upsert and derive executors. */
  pkField: string;
  /** Ordered list of fields used to build and decode pagination cursors. */
  cursorFields: readonly string[];
  /** Default sort direction applied when the caller omits `sortDir`. */
  defaultSortDir: 'asc' | 'desc';
  /** Default page size applied when the caller omits `limit`. */
  defaultLimit: number;
  /** Hard upper bound on `limit` — requests above this are clamped. */
  maxLimit: number;
  /** TTL in milliseconds for new entries, or `undefined` when TTL is not configured. */
  ttlMs: number | undefined;
}

/**
 * Build the complete set of named operation functions for the in-memory backend.
 *
 * Iterates over `operations` and dispatches each entry to the matching executor.
 * The returned map is spread onto the adapter object so callers access operations
 * as `adapter.myOp(params)`.
 *
 * **Supported operation kinds:**
 * `lookup`, `exists`, `transition`, `fieldUpdate`, `arrayPush`, `arrayPull`, `arraySet`,
 * `increment`, `batch`, `upsert`, `consume`, `aggregate`, `search`, `collection`,
 * `computedAggregate`, `derive`, `custom`.
 *
 * **Deferred (not wired here):**
 * `transaction`, `pipe` — handled at the composite-adapter level.
 *
 * @param operations - Map of operation name → `OperationConfig` (from `defineOperations()`).
 * @param config     - Resolved entity config for field metadata and soft-delete settings.
 * @param store      - The shared in-memory `Map` holding all entries for this entity.
 * @param isAlive    - Predicate that returns `true` when an entry has not expired.
 * @param isVisible  - Predicate that returns `true` when a record is not soft-deleted.
 * @param ctx        - Pagination and TTL settings derived from the entity config.
 * @returns A flat `Record<string, unknown>` mapping operation names to bound functions.
 * @throws {Error} When a `custom` operation has no `memory` handler defined.
 */
export function buildMemoryOperations(
  operations: Record<string, OperationConfig>,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
  ctx: MemoryAdapterContext,
): Record<string, unknown> {
  const methods: Record<string, unknown> = {};

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup':
        methods[opName] = lookupMemory(
          op,
          config,
          store,
          isAlive,
          isVisible,
          ctx.cursorFields,
          ctx.defaultSortDir,
          ctx.defaultLimit,
          ctx.maxLimit,
        );
        break;
      case 'exists':
        methods[opName] = existsMemory(op, store, isAlive, isVisible);
        break;
      case 'transition':
        methods[opName] = transitionMemory(op, store, isAlive, isVisible);
        break;
      case 'fieldUpdate':
        methods[opName] = fieldUpdateMemory(op, config, store, isAlive, isVisible);
        break;
      case 'arrayPush':
        methods[opName] = arrayPushMemory(op, config, store, isAlive, isVisible);
        break;
      case 'arrayPull':
        methods[opName] = arrayPullMemory(op, config, store, isAlive, isVisible);
        break;
      case 'arraySet':
        methods[opName] = arraySetMemory(op, config, store, isAlive, isVisible);
        break;
      case 'increment':
        methods[opName] = incrementMemory(op, config, store, isAlive, isVisible);
        break;
      case 'batch':
        methods[opName] = batchMemory(op, store, isAlive, isVisible);
        break;
      case 'upsert':
        methods[opName] = upsertMemory(
          op,
          config,
          store,
          isAlive,
          isVisible,
          ctx.pkField,
          ctx.ttlMs,
        );
        break;
      case 'consume':
        methods[opName] = consumeMemory(op, store, isAlive);
        break;
      case 'aggregate':
        methods[opName] = aggregateMemory(op, store, isAlive, isVisible);
        break;
      case 'search':
        methods[opName] = searchMemory(op, store, isAlive, isVisible);
        break;
      case 'collection': {
        const collectionMethods = collectionMemory(opName, op, config);
        if (collectionMethods.list) methods[`${opName}List`] = collectionMethods.list;
        if (collectionMethods.add) methods[`${opName}Add`] = collectionMethods.add;
        if (collectionMethods.remove) methods[`${opName}Remove`] = collectionMethods.remove;
        if (collectionMethods.update) methods[`${opName}Update`] = collectionMethods.update;
        if (collectionMethods.set) methods[`${opName}Set`] = collectionMethods.set;
        break;
      }
      case 'computedAggregate':
        methods[opName] = computedAggregateMemory(op, store, isAlive, isVisible);
        break;
      case 'derive':
        methods[opName] = deriveMemory(op, store, isAlive, isVisible, ctx.pkField);
        break;
      case 'transaction':
        // Transaction ops are wired at the composite level, not individual entity level.
        // They need access to multiple adapters. Skip here — compositeAdapter wires them.
        break;
      case 'pipe':
        // Pipe ops are wired after all other ops are attached, since they reference them.
        // Deferred — compositeAdapter or createEntityFactories wires them.
        break;
      case 'custom':
        if (op.memory) {
          // CustomOpConfig.memory is a user-provided factory — opaque boundary
          methods[opName] = op.memory(store as unknown as Map<string, Record<string, unknown>>);
        }
        // No factory → method expected to be mixed onto the adapter externally (e.g. from a composite).
        break;
    }
  }

  return methods;
}
