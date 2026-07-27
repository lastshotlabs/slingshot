/**
 * Runtime executor: op.transaction — cross-entity atomic writes.
 *
 * Executes a sequence of steps across multiple entity adapters.
 * SQLite and PostgreSQL callers provide the real transaction boundary.
 *
 * Steps can reference params and previous step results via 'param:x' and 'result:N.field'
 * or 'result:N.nested.field'.
 */
import {
  EntityTransactionConflictError,
  TransactionBindingError,
} from '@lastshotlabs/slingshot-core';
import type {
  EntityAdapter,
  OperationConfig,
  TransactionOpConfig,
  TransactionStepResult,
} from '@lastshotlabs/slingshot-core';

export type AdapterMap = Partial<
  Record<string, EntityAdapter<unknown, unknown, unknown> & Record<string, unknown>>
>;

interface MatchedRecord {
  readonly id: string | number;
  readonly record: Record<string, unknown>;
}

function withoutPrimaryKey(
  match: Record<string, unknown>,
  primaryKey: string,
): Record<string, unknown> | undefined {
  const guard = Object.fromEntries(Object.entries(match).filter(([field]) => field !== primaryKey));
  return Object.keys(guard).length > 0 ? guard : undefined;
}

interface BindingContext {
  readonly params: Record<string, unknown>;
  readonly results: readonly TransactionStepResult[];
  readonly operationName?: string;
  readonly stepIndex: number;
}

function invalidBinding(context: BindingContext, message: string): never {
  throw new TransactionBindingError(message, context.operationName, context.stepIndex);
}

function resolveValue(value: unknown, context: BindingContext): unknown {
  if (Array.isArray(value)) return value.map(item => resolveValue(item, context));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolveValue(nested, context)]),
    );
  }
  if (typeof value !== 'string') return value;
  if (value.startsWith('param:')) {
    const key = value.slice(6);
    if (!key || !Object.prototype.hasOwnProperty.call(context.params, key)) {
      invalidBinding(context, `Transaction parameter '${key}' is missing.`);
    }
    return context.params[key];
  }
  if (value.startsWith('result:')) {
    const match = /^result:(\d+)(?:\.([A-Za-z_][A-Za-z0-9_.]*))?$/u.exec(value);
    if (!match) invalidBinding(context, `Transaction result binding '${value}' is malformed.`);
    const index = Number(match[1]);
    if (index >= context.results.length) {
      invalidBinding(context, `Transaction result ${index} is not available.`);
    }
    let resolved: unknown = context.results[index];
    if (!match[2]) return resolved;
    for (const key of match[2].split('.')) {
      if (
        resolved === null ||
        typeof resolved !== 'object' ||
        !Object.prototype.hasOwnProperty.call(resolved, key)
      ) {
        invalidBinding(context, `Transaction result binding '${value}' does not exist.`);
      }
      resolved = (resolved as Record<string, unknown>)[key];
    }
    return resolved;
  }
  if (value === 'now') return new Date();
  return value;
}

function resolveRecord(
  record: Readonly<Record<string, unknown>> | undefined,
  context: BindingContext,
): Record<string, unknown> {
  if (!record) return {};
  return resolveValue(record, context) as Record<string, unknown>;
}

function collectNativeParams(
  template: unknown,
  resolved: unknown,
  target: Record<string, unknown>,
): void {
  if (typeof template === 'string' && template.startsWith('param:')) {
    const key = template.slice(6);
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = resolved;
    }
    return;
  }
  if (Array.isArray(template) && Array.isArray(resolved)) {
    for (const [index, item] of template.entries()) {
      collectNativeParams(item, resolved[index], target);
    }
    return;
  }
  if (
    template &&
    resolved &&
    typeof template === 'object' &&
    typeof resolved === 'object' &&
    !Array.isArray(template) &&
    !Array.isArray(resolved)
  ) {
    for (const [key, nested] of Object.entries(template)) {
      if (Object.prototype.hasOwnProperty.call(resolved, key)) {
        collectNativeParams(nested, (resolved as Record<string, unknown>)[key], target);
      }
    }
  }
}

function getNativeOperation(
  options: TransactionExecutorOptions | undefined,
  entity: string,
  operation: string,
): OperationConfig | undefined {
  return options?.operationConfigs?.[entity]?.[operation];
}

function getNativeMethod(
  adapter: EntityAdapter<unknown, unknown, unknown> & Record<string, unknown>,
  entity: string,
  operation: string,
): (...args: unknown[]) => Promise<unknown> {
  const method = adapter[operation];
  if (typeof method !== 'function') {
    throw new Error(
      `[transaction] Configured operation '${operation}' is missing on entity '${entity}' adapter`,
    );
  }
  return method.bind(adapter) as (...args: unknown[]) => Promise<unknown>;
}

function isNativeRequiredMiss(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/\] Not found$/u.test(error.message) || /\] Record not found$/u.test(error.message))
  );
}

function requiredMutationConflict(
  entity: string,
  operation: string,
  stepIndex: number,
): EntityTransactionConflictError {
  return new EntityTransactionConflictError(
    `Transaction operation '${operation}' did not match a required '${entity}' record.`,
    entity,
    operation,
    stepIndex,
  );
}

function assertRecordResult(
  value: unknown,
  entity: string,
  operation: string,
): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(
    `[transaction] Operation '${operation}' on entity '${entity}' returned an invalid result`,
  );
}

async function findMatchedRecord(
  adapter: EntityAdapter<unknown, unknown, unknown>,
  entityName: string,
  match: Record<string, unknown>,
  primaryKey: string,
): Promise<MatchedRecord | null> {
  const directId = match[primaryKey];
  if (typeof directId === 'string' || typeof directId === 'number') {
    const record = (await adapter.getById(
      directId,
      withoutPrimaryKey(match, primaryKey),
    )) as Record<string, unknown> | null;
    return record ? { id: directId, record } : null;
  }

  const matches = await adapter.list({ filter: match, limit: 2 });
  if (matches.items.length === 0) return null;
  if (matches.items.length > 1) {
    throw new Error(`[transaction] Match for entity '${entityName}' selected more than one record`);
  }

  const record = matches.items[0] as Record<string, unknown>;
  const resolvedId = record[primaryKey];
  if (typeof resolvedId !== 'string' && typeof resolvedId !== 'number') {
    throw new Error(
      `[transaction] Matched entity '${entityName}' has no usable primary key '${primaryKey}'`,
    );
  }
  return { id: resolvedId, record };
}

/**
 * Build a transaction executor for a composite (multi-entity) adapter.
 *
 * Executes `op.steps` sequentially across the `adapters` map. Each step targets
 * one entity adapter by name and performs one of the following operations:
 * `create`, `update`, `delete`, `fieldUpdate`, `transition`, `batch`,
 * `arrayPush`, `arrayPull`, `lookup`, or `increment`.
 *
 * **Input resolution:** Step binding records support:
 * - `param:x` → value from the original `params` argument.
 * - `result:N.field` or `result:N.nested.field` → a (possibly nested) field of the N-th step's result (0-indexed).
 * - `'now'` → the current `Date`.
 * - Any other literal value → passed through unchanged.
 *
 * **Return value:** An array of result records or `null`, one per step. The index in the
 * array corresponds to the step index and can be referenced by subsequent steps
 * via `result:N.field`.
 * - `delete` steps produce `{ deleted: true }`.
 * - Native boolean transitions produce `{ applied: true }`; a guard miss throws HTTP 409.
 * - Native numeric batches produce `{ count }`.
 * - `lookup` steps that find no record produce `null`.
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
 * @returns An async function `(params) => Promise<TransactionStepResult[]>`.
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
export interface TransactionExecutorOptions {
  readonly wrapInTransaction?: (fn: () => Promise<void>) => Promise<void>;
  readonly primaryKeys?: Readonly<Record<string, string>>;
  readonly operationName?: string;
  readonly operationConfigs?: Readonly<
    Record<string, Readonly<Record<string, OperationConfig>> | undefined>
  >;
}

export function transactionExecutor(
  op: TransactionOpConfig,
  adapters: AdapterMap,
  options?: TransactionExecutorOptions,
): (params: Record<string, unknown>) => Promise<TransactionStepResult[]> {
  return async params => {
    const results: TransactionStepResult[] = [];

    const executeSteps = async (): Promise<void> => {
      for (const [stepIndex, step] of op.steps.entries()) {
        const adapter = adapters[step.entity];
        if (!adapter) {
          throw new Error(`[transaction] Entity '${step.entity}' not found in composite adapter`);
        }
        const primaryKey = options?.primaryKeys?.[step.entity] ?? 'id';
        const context: BindingContext = {
          params,
          results,
          operationName: options?.operationName,
          stepIndex,
        };

        let result: TransactionStepResult;

        switch (step.op) {
          case 'create': {
            const input = resolveRecord(step.input, context);
            result = (await adapter.create(input)) as Record<string, unknown>;
            break;
          }

          case 'update': {
            const match = resolveRecord(step.match, context);
            const matched = await findMatchedRecord(adapter, step.entity, match, primaryKey);
            if (!matched) {
              throw requiredMutationConflict(step.entity, 'update', stepIndex);
            }
            const input = resolveRecord(step.set, context);
            const updated = await adapter.update(
              matched.id,
              input,
              withoutPrimaryKey(match, primaryKey),
            );
            if (!updated) {
              throw requiredMutationConflict(step.entity, 'update', stepIndex);
            }
            result = updated as Record<string, unknown>;
            break;
          }

          case 'delete': {
            const match = resolveRecord(step.match, context);
            const matched = await findMatchedRecord(adapter, step.entity, match, primaryKey);
            const deleted = matched
              ? await adapter.delete(matched.id, withoutPrimaryKey(match, primaryKey))
              : false;
            result = { deleted };
            break;
          }

          case 'fieldUpdate': {
            const input = resolveRecord(step.input, context);
            const nativeParams = { ...params, ...input };
            const native = getNativeOperation(options, step.entity, step.operation);
            if (native?.kind === 'fieldUpdate') {
              collectNativeParams(native.match, input, nativeParams);
            }
            try {
              const value = await getNativeMethod(
                adapter,
                step.entity,
                step.operation,
              )(nativeParams, input);
              if (value === null || value === false) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              result = assertRecordResult(value, step.entity, step.operation);
            } catch (error) {
              if (error instanceof EntityTransactionConflictError) throw error;
              if (isNativeRequiredMiss(error)) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              throw error;
            }
            break;
          }

          case 'transition': {
            const input = resolveRecord(step.input, context);
            const nativeParams = { ...params, ...input };
            const native = getNativeOperation(options, step.entity, step.operation);
            if (native?.kind === 'transition') {
              collectNativeParams(native.match, input, nativeParams);
              collectNativeParams(native.set, input, nativeParams);
            }
            try {
              const value = await getNativeMethod(
                adapter,
                step.entity,
                step.operation,
              )(nativeParams);
              if (value === null || value === false) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              result =
                value === true
                  ? { applied: true }
                  : assertRecordResult(value, step.entity, step.operation);
            } catch (error) {
              if (error instanceof EntityTransactionConflictError) throw error;
              if (isNativeRequiredMiss(error)) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              throw error;
            }
            break;
          }

          case 'batch': {
            const input = resolveRecord(step.input, context);
            const nativeParams = { ...params, ...input };
            const native = getNativeOperation(options, step.entity, step.operation);
            if (native?.kind === 'batch') {
              collectNativeParams(native.filter, input, nativeParams);
              collectNativeParams(native.set, input, nativeParams);
            }
            const value = await getNativeMethod(adapter, step.entity, step.operation)(nativeParams);
            if (typeof value === 'number') {
              result = { count: value };
            } else {
              result = assertRecordResult(value, step.entity, step.operation);
            }
            break;
          }

          case 'arrayPush': {
            const input = resolveRecord(step.input, context);
            const id = input[primaryKey] ?? input.id;
            if (typeof id !== 'string' && typeof id !== 'number') {
              invalidBinding(context, `Transaction array push requires '${primaryKey}'.`);
            }
            if (!Object.prototype.hasOwnProperty.call(input, 'value')) {
              invalidBinding(context, "Transaction array push requires 'value'.");
            }
            const value = input.value;
            try {
              result = assertRecordResult(
                await getNativeMethod(adapter, step.entity, step.operation)(id, value),
                step.entity,
                step.operation,
              );
            } catch (error) {
              if (isNativeRequiredMiss(error)) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              throw error;
            }
            break;
          }

          case 'arrayPull': {
            const input = resolveRecord(step.input, context);
            const id = input[primaryKey] ?? input.id;
            if (typeof id !== 'string' && typeof id !== 'number') {
              invalidBinding(context, `Transaction array pull requires '${primaryKey}'.`);
            }
            if (!Object.prototype.hasOwnProperty.call(input, 'value')) {
              invalidBinding(context, "Transaction array pull requires 'value'.");
            }
            const value = input.value;
            try {
              result = assertRecordResult(
                await getNativeMethod(adapter, step.entity, step.operation)(id, value),
                step.entity,
                step.operation,
              );
            } catch (error) {
              if (isNativeRequiredMiss(error)) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              throw error;
            }
            break;
          }

          case 'lookup': {
            const match = resolveRecord(step.match, context);
            const matched = await findMatchedRecord(adapter, step.entity, match, primaryKey);
            result = matched?.record ?? null;
            break;
          }

          case 'increment': {
            const input = resolveRecord(step.input, context);
            const id = input[primaryKey] ?? input.id;
            if (typeof id !== 'string' && typeof id !== 'number') {
              invalidBinding(context, `Transaction increment requires '${primaryKey}'.`);
            }
            const by = typeof input.by === 'number' ? input.by : undefined;
            try {
              result = assertRecordResult(
                await getNativeMethod(adapter, step.entity, step.operation)(id, by),
                step.entity,
                step.operation,
              );
            } catch (error) {
              if (isNativeRequiredMiss(error)) {
                throw requiredMutationConflict(step.entity, step.operation, stepIndex);
              }
              throw error;
            }
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
