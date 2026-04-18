/**
 * MongoDB backend operation wiring.
 *
 * Iterates over a `Record<string, OperationConfig>` and dispatches each entry to
 * the corresponding MongoDB executor function, returning a flat map of
 * `operationName → bound function` that is spread onto the adapter object.
 *
 * Executors receive a `getModel()` factory (rather than a direct model reference)
 * so the Mongoose model is resolved lazily after Mongoose has registered the schema.
 * A `fromDoc` helper translates raw Mongoose lean documents to domain-typed records.
 *
 * **Special cases:**
 * - `collection` expands into up to five sub-methods: `{opName}List`, `{opName}Add`,
 *   `{opName}Remove`, `{opName}Update`, `{opName}Set`.
 * - `transaction` and `pipe` are skipped — wired at the composite-adapter level.
 * - `custom` invokes `op.mongo(getModel())` if provided; throws otherwise.
 *
 * **Adding a new operation kind:**
 * 1. Add a `case 'myKind':` block here calling the corresponding `myKindMongo()` executor.
 * 2. Add the same case to `memoryOperationWiring.ts`, `sqliteOperationWiring.ts`,
 *    `postgresOperationWiring.ts`, and `redisOperationWiring.ts`.
 * 3. Implement `myKindMongo()` in `operationExecutors/myKind.ts`.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { fromMongoDoc } from './fieldUtils';
import { aggregateMongo } from './operationExecutors/aggregate';
import { arrayPullMongo } from './operationExecutors/arrayPull';
import { arrayPushMongo } from './operationExecutors/arrayPush';
import { arraySetMongo } from './operationExecutors/arraySet';
import { batchMongo } from './operationExecutors/batch';
import { collectionMongo } from './operationExecutors/collection';
import { computedAggregateMongo } from './operationExecutors/computedAggregate';
import { consumeMongo } from './operationExecutors/consume';
import type { MongoModel } from './operationExecutors/dbInterfaces';
import { deriveMongo } from './operationExecutors/derive';
import { existsMongo } from './operationExecutors/exists';
import { fieldUpdateMongo } from './operationExecutors/fieldUpdate';
import { incrementMongo } from './operationExecutors/increment';
import { lookupMongo } from './operationExecutors/lookup';
import { searchMongo } from './operationExecutors/search';
import { transitionMongo } from './operationExecutors/transition';
import { upsertMongo } from './operationExecutors/upsert';

/**
 * Build the complete set of named operation functions for the MongoDB backend.
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
 * @param config     - Resolved entity config for field metadata, soft-delete, and pk settings.
 * @param getModel   - Factory that returns the Mongoose model; called lazily so schema
 *                     registration completes before the first query.
 * @returns A flat `Record<string, unknown>` mapping operation names to bound functions.
 * @throws {Error} When a `custom` operation has no `mongo` handler defined.
 */
export function buildMongoOperations(
  operations: Record<string, OperationConfig>,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
): Record<string, unknown> {
  const methods: Record<string, unknown> = {};
  const fromDoc = (doc: Record<string, unknown>) => fromMongoDoc(doc, config);

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup':
        methods[opName] = lookupMongo(op, config, getModel, fromDoc);
        break;
      case 'exists':
        methods[opName] = existsMongo(op, config, getModel);
        break;
      case 'transition':
        methods[opName] = transitionMongo(op, config, getModel, fromDoc);
        break;
      case 'fieldUpdate':
        methods[opName] = fieldUpdateMongo(op, config, getModel, fromDoc);
        break;
      case 'arrayPush':
        methods[opName] = arrayPushMongo(op, config, getModel, fromDoc);
        break;
      case 'arrayPull':
        methods[opName] = arrayPullMongo(op, config, getModel, fromDoc);
        break;
      case 'arraySet':
        methods[opName] = arraySetMongo(op, config, getModel, fromDoc);
        break;
      case 'increment':
        methods[opName] = incrementMongo(op, config, getModel, fromDoc);
        break;
      case 'batch':
        methods[opName] = batchMongo(op, getModel);
        break;
      case 'upsert':
        methods[opName] = upsertMongo(op, config, getModel, fromDoc);
        break;
      case 'consume':
        methods[opName] = consumeMongo(op, getModel, fromDoc);
        break;
      case 'aggregate':
        methods[opName] = aggregateMongo(op, getModel);
        break;
      case 'search':
        methods[opName] = searchMongo(op, getModel, fromDoc);
        break;
      case 'collection': {
        const coll = collectionMongo(opName, op, config, getModel);
        if (coll.list) methods[`${opName}List`] = coll.list;
        if (coll.add) methods[`${opName}Add`] = coll.add;
        if (coll.remove) methods[`${opName}Remove`] = coll.remove;
        if (coll.update) methods[`${opName}Update`] = coll.update;
        if (coll.set) methods[`${opName}Set`] = coll.set;
        break;
      }
      case 'computedAggregate':
        methods[opName] = computedAggregateMongo(op, config, getModel);
        break;
      case 'derive':
        methods[opName] = deriveMongo(op, config, getModel, fromDoc);
        break;
      case 'transaction':
      case 'pipe':
        break;
      case 'custom':
        if (op.mongo) {
          methods[opName] = op.mongo(getModel());
        }
        // No factory → method expected to be mixed onto the adapter externally (e.g. from a composite).
        break;
    }
  }

  return methods;
}
