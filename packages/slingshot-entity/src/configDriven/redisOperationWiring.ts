/**
 * Redis backend operation wiring.
 *
 * Iterates over a `Record<string, OperationConfig>` and dispatches each entry to
 * the corresponding Redis executor function, returning a flat map of
 * `operationName → bound function` that is spread onto the adapter object.
 *
 * Executors receive a `RedisLike` client, a key `prefix`, a `scanAllKeys()` helper
 * (abstracts over `SCAN`), a `storeRecord()` writer, and per-record helpers
 * (`isVisible`, `fromRedis`) by closure.  All read operations call `scanAllKeys()`
 * to enumerate keys, then fetch each with `GET`; this is appropriate for entities
 * that are small in total count and not used as primary hot-path stores.
 *
 * **Special cases:**
 * - `collection` expands into up to five sub-methods: `{opName}List`, `{opName}Add`,
 *   `{opName}Remove`, `{opName}Update`, `{opName}Set`.
 * - `transaction` and `pipe` are skipped — wired at the composite-adapter level.
 * - `custom` invokes `op.redis(redis)` if provided; throws otherwise.
 *
 * **Adding a new operation kind:**
 * 1. Add a `case 'myKind':` block here calling the corresponding `myKindRedis()` executor.
 * 2. Add the same case to `memoryOperationWiring.ts`, `sqliteOperationWiring.ts`,
 *    `postgresOperationWiring.ts`, and `mongoOperationWiring.ts`.
 * 3. Implement `myKindRedis()` in `operationExecutors/myKind.ts`.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '@lastshotlabs/slingshot-core';
import { fromRedisRecord, isSoftDeleted } from './fieldUtils';
import { aggregateRedis } from './operationExecutors/aggregate';
import { arrayPullRedis } from './operationExecutors/arrayPull';
import { arrayPushRedis } from './operationExecutors/arrayPush';
import { arraySetRedis } from './operationExecutors/arraySet';
import { batchRedis } from './operationExecutors/batch';
import { collectionRedis } from './operationExecutors/collection';
import { computedAggregateRedis } from './operationExecutors/computedAggregate';
import { consumeRedis } from './operationExecutors/consume';
import { deriveRedis } from './operationExecutors/derive';
import { existsRedis } from './operationExecutors/exists';
import { fieldUpdateRedis } from './operationExecutors/fieldUpdate';
import { incrementRedis } from './operationExecutors/increment';
import { lookupRedis } from './operationExecutors/lookup';
import { searchRedis } from './operationExecutors/search';
import { transitionRedis } from './operationExecutors/transition';
import { upsertRedis } from './operationExecutors/upsert';

/**
 * Build the complete set of named operation functions for the Redis backend.
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
 * @param operations   - Map of operation name → `OperationConfig` (from `defineOperations()`).
 * @param config       - Resolved entity config for field metadata and soft-delete settings.
 * @param redis        - The `RedisLike` client (ioredis or compatible).
 * @param prefix       - Key prefix string used by collection executors to namespace keys.
 * @param scanAllKeys  - Async helper that returns all Redis keys for this entity via SCAN.
 * @param storeRecord  - Async helper that serializes and writes a full record back to Redis.
 * @returns A flat `Record<string, unknown>` mapping operation names to bound async functions.
 * @throws {Error} When a `custom` operation has no `redis` handler defined.
 */
export function buildRedisOperations(
  operations: Record<string, OperationConfig>,
  config: ResolvedEntityConfig,
  redis: RedisLike,
  prefix: string,
  scanAllKeys: () => Promise<string[]>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): Record<string, unknown> {
  const methods: Record<string, unknown> = {};
  const isVisible = (record: Record<string, unknown>) => !isSoftDeleted(record, config);
  const fromRedis = (raw: Record<string, unknown>) => fromRedisRecord(raw, config.fields);

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup':
        methods[opName] = lookupRedis(op, config, redis, scanAllKeys, isVisible, fromRedis);
        break;
      case 'exists':
        methods[opName] = existsRedis(op, redis, scanAllKeys, isVisible, fromRedis);
        break;
      case 'transition':
        methods[opName] = transitionRedis(
          op,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'fieldUpdate':
        methods[opName] = fieldUpdateRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'arrayPush':
        methods[opName] = arrayPushRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'arrayPull':
        methods[opName] = arrayPullRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'arraySet':
        methods[opName] = arraySetRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'increment':
        methods[opName] = incrementRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'batch':
        methods[opName] = batchRedis(op, redis, scanAllKeys, isVisible, fromRedis, storeRecord);
        break;
      case 'upsert':
        methods[opName] = upsertRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'consume':
        methods[opName] = consumeRedis(op, redis, scanAllKeys, fromRedis);
        break;
      case 'aggregate':
        methods[opName] = aggregateRedis(op, redis, scanAllKeys, isVisible, fromRedis);
        break;
      case 'search':
        methods[opName] = searchRedis(op, redis, scanAllKeys, isVisible, fromRedis);
        break;
      case 'collection': {
        const coll = collectionRedis(opName, op, config, redis, prefix);
        if (coll.list) methods[`${opName}List`] = coll.list;
        if (coll.add) methods[`${opName}Add`] = coll.add;
        if (coll.remove) methods[`${opName}Remove`] = coll.remove;
        if (coll.update) methods[`${opName}Update`] = coll.update;
        if (coll.set) methods[`${opName}Set`] = coll.set;
        break;
      }
      case 'computedAggregate':
        methods[opName] = computedAggregateRedis(
          op,
          config,
          redis,
          scanAllKeys,
          isVisible,
          fromRedis,
          storeRecord,
        );
        break;
      case 'derive':
        methods[opName] = deriveRedis(op, config, redis, scanAllKeys, isVisible, fromRedis);
        break;
      case 'transaction':
      case 'pipe':
        break;
      case 'custom':
        if (op.redis) {
          methods[opName] = op.redis(redis);
        }
        // No factory → method expected to be mixed onto the adapter externally (e.g. from a composite).
        break;
    }
  }

  return methods;
}
