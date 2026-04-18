/**
 * Runtime executor: op.transaction — cross-entity atomic writes.
 *
 * Executes a sequence of steps across multiple entity adapters.
 * Memory: sequential (single-threaded = atomic).
 * SQL: wrapped in BEGIN/COMMIT when `wrapInTransaction` is supplied.
 *
 * Steps can reference params and previous step results via 'param:x' and 'result:N.field'
 * or 'result:N.nested.field'.
 */
import type { TransactionOpConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';

export type AdapterMap = Partial<
  Record<string, EntityAdapter<unknown, unknown, unknown> & Record<string, unknown>>
>;

function resolveValue(
  value: unknown,
  params: Record<string, unknown>,
  results: Array<Record<string, unknown>>,
): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('param:')) return params[value.slice(6)];
  if (value.startsWith('result:')) {
    // Format: result:N.field or result:N.nested.field
    const rest = value.slice(7); // e.g. "0.id" or "0.metadata.title"
    const dotIdx = rest.indexOf('.');
    if (dotIdx === -1) return results[Number(rest)];
    const idx = Number(rest.slice(0, dotIdx));
    const fieldPath = rest.slice(dotIdx + 1);
    return fieldPath
      .split('.')
      .reduce<unknown>(
        (obj, key) =>
          obj != null && typeof obj === 'object'
            ? (obj as Record<string, unknown>)[key]
            : undefined,
        results[idx],
      );
  }
  if (value === 'now') return new Date();
  return value;
}

function resolveRecord(
  record: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
  results: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (!record) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = resolveValue(value, params, results);
  }
  return resolved;
}

/**
 * Build a transaction executor for a composite (multi-entity) adapter.
 *
 * Executes `op.steps` sequentially across the `adapters` map. Each step targets
 * one entity adapter by name and performs one of the following operations:
 * `create`, `update`, `delete`, `fieldUpdate`, `transition`, `batch`,
 * `arrayPush`, `arrayPull`, `lookup`, or `increment`.
 *
 * **Input resolution:** Step fields (`input`, `match`, `set`, `value`) support:
 * - `param:x` → value from the original `params` argument.
 * - `result:N.field` or `result:N.nested.field` → a (possibly nested) field of the N-th step's result (0-indexed).
 * - `'now'` → the current `Date`.
 * - Any other literal value → passed through unchanged.
 *
 * **Return value:** An array of result objects, one per step. The index in the
 * array corresponds to the step index and can be referenced by subsequent steps
 * via `result:N.field`.
 * - `delete` steps produce `{ deleted: true }`.
 * - `transition` steps that fail the guard produce `{ transitionFailed: true }`.
 * - `lookup` steps that find no record produce `{}`.
 *
 * **Atomicity:** Steps execute sequentially in JavaScript. When `options.wrapInTransaction`
 * is provided, the entire step sequence runs inside that wrapper (e.g. a SQLite
 * BEGIN/COMMIT block). Without a wrapper, failures do not roll back earlier steps.
 *
 * @param op - Transaction operation config with a `steps` array.
 * @param adapters - Map of entity name → adapter. Entity names must match the keys
 *   of the composite adapter passed during factory setup.
 * @param options - Optional executor options.
 * @param options.wrapInTransaction - When provided, wraps the entire step sequence
 *   in a transaction (e.g. SQLite BEGIN/COMMIT). The function receives an async
 *   callback and is responsible for opening, committing, and rolling back.
 * @returns An async function `(params) => Promise<Array<Record<string, unknown>>>`.
 * @throws If a step's `entity` name is not present in `adapters`.
 *
 * @example
 * ```ts
 * // Cross-entity write: create message + update room in one call
 * const executor = transactionExecutor(op, { messages: msgAdapter, rooms: roomAdapter });
 * const results = await executor({ roomId: 'r1', content: 'Hello' });
 *
 * // Bidirectional array push on the same entity:
 * const executor = transactionExecutor(op, { documents: docAdapter });
 * const results = await executor({ sourceId: 'a', targetId: 'b' });
 * // step 0: arrayPush outwardLinks on doc 'a' with value 'b'
 * // step 1: arrayPush inwardLinks on doc 'b' with value 'a'
 *
 * // Read-then-write (revert pattern):
 * // step 0: lookup snapshot by id → result[0] has title/body
 * // step 1: fieldUpdate document using result:0.title and result:0.body
 * // step 2: create new snapshot with type:'revert'
 * ```
 */
export function transactionExecutor(
  op: TransactionOpConfig,
  adapters: AdapterMap,
  options?: { wrapInTransaction?: (fn: () => Promise<void>) => Promise<void> },
): (params: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> {
  return async params => {
    const results: Array<Record<string, unknown>> = [];

    const executeSteps = async (): Promise<void> => {
      for (const step of op.steps) {
        const adapter = adapters[step.entity];
        if (!adapter) {
          throw new Error(`[transaction] Entity '${step.entity}' not found in composite adapter`);
        }

        let result: Record<string, unknown> = {};

        switch (step.op) {
          case 'create': {
            const input = resolveRecord(step.input, params, results);
            result = (await adapter.create(input)) as Record<string, unknown>;
            break;
          }

          case 'update': {
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            const input = resolveRecord(step.set, params, results);
            result = (await adapter.update(id as string | number, input)) as Record<
              string,
              unknown
            >;
            break;
          }

          case 'delete': {
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            await adapter.delete(id as string | number);
            result = { deleted: true };
            break;
          }

          case 'fieldUpdate': {
            const matchResolved = resolveRecord(step.match, params, results);
            const setResolved = resolveRecord(step.set, params, results);
            // fieldUpdate ops are named on the adapter — find the first one matching convention
            // or fall back to calling adapter.update with the set fields directly.
            const fn = (adapter as Record<string, unknown>)['fieldUpdate'];
            if (typeof fn === 'function') {
              result = await (
                fn as (
                  a: Record<string, unknown>,
                  b: Record<string, unknown>,
                ) => Promise<Record<string, unknown>>
              )(matchResolved, setResolved);
            } else {
              // Fallback: partial update via adapter.update using the match id
              const id = matchResolved.id ?? matchResolved[Object.keys(matchResolved)[0]];
              result = (await adapter.update(id as string | number, setResolved)) as Record<
                string,
                unknown
              >;
            }
            break;
          }

          case 'transition': {
            const matchResolved = resolveRecord(step.match, params, results);
            if (step.field && step.from !== undefined && step.to !== undefined) {
              const id = matchResolved.id ?? matchResolved[Object.keys(matchResolved)[0]];
              const entity = (await adapter.getById(id as string | number)) as Record<
                string,
                unknown
              > | null;
              if (entity && entity[step.field] === step.from) {
                const updateInput: Record<string, unknown> = { [step.field]: step.to };
                const setResolved = resolveRecord(step.set, params, results);
                Object.assign(updateInput, setResolved);
                result = (await adapter.update(id as string | number, updateInput)) as Record<
                  string,
                  unknown
                >;
              } else {
                result = { transitionFailed: true };
              }
            }
            break;
          }

          case 'batch': {
            // Batch steps delegate to a named 'batch' op on the adapter if present.
            // Full batch support requires the named op to be wired — this is a best-effort
            // dispatch; consumers should prefer dedicated step types where possible.
            const batchFn = (adapter as Record<string, unknown>)['batch'];
            if (typeof batchFn === 'function') {
              const filterResolved = resolveRecord(
                step.filter as Record<string, unknown> | undefined,
                params,
                results,
              );
              result = {
                count: await (batchFn as (f: Record<string, unknown>) => Promise<number>)(
                  filterResolved,
                ),
              };
            } else {
              result = { count: 0 };
            }
            break;
          }

          case 'arrayPush': {
            if (!step.field) break;
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            const value = resolveValue(step.value, params, results);
            const dedupe = step.dedupe !== false;
            // Read-modify-write: get current array, push value, write back.
            const entity = (await adapter.getById(id as string | number)) as Record<
              string,
              unknown
            > | null;
            if (!entity) throw new Error(`[transaction] arrayPush: record not found`);
            const current = Array.isArray(entity[step.field])
              ? [...(entity[step.field] as unknown[])]
              : [];
            if (dedupe && current.includes(value)) {
              result = entity;
            } else {
              current.push(value);
              result = (await adapter.update(id as string | number, {
                ...entity,
                [step.field]: current,
              })) as Record<string, unknown>;
            }
            break;
          }

          case 'arrayPull': {
            if (!step.field) break;
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            const value = resolveValue(step.value, params, results);
            // Read-modify-write: get current array, filter out value, write back.
            const entity = (await adapter.getById(id as string | number)) as Record<
              string,
              unknown
            > | null;
            if (!entity) throw new Error(`[transaction] arrayPull: record not found`);
            const filtered = Array.isArray(entity[step.field])
              ? (entity[step.field] as unknown[]).filter(v => v !== value)
              : [];
            result = (await adapter.update(id as string | number, {
              ...entity,
              [step.field]: filtered,
            })) as Record<string, unknown>;
            break;
          }

          case 'lookup': {
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            const entity = (await adapter.getById(id as string | number)) as Record<
              string,
              unknown
            > | null;
            result = entity ?? {};
            break;
          }

          case 'increment': {
            if (!step.field) break;
            const match = resolveRecord(step.match, params, results);
            const id = match.id ?? match[Object.keys(match)[0]];
            const by = typeof step.by === 'number' ? step.by : 1;
            const entity = (await adapter.getById(id as string | number)) as Record<
              string,
              unknown
            > | null;
            if (!entity) throw new Error(`[transaction] increment: record not found`);
            const current = entity[step.field];
            const next = typeof current === 'number' ? current + by : by;
            result = (await adapter.update(id as string | number, {
              ...entity,
              [step.field]: next,
            })) as Record<string, unknown>;
            break;
          }
        }

        results.push(result);
      }
    }; // end executeSteps

    if (options?.wrapInTransaction) {
      await options.wrapInTransaction(executeSteps);
    } else {
      await executeSteps();
    }
    return results;
  };
}
