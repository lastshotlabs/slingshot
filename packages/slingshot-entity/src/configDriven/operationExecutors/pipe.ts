/**
 * Runtime executor: op.pipe — operation composition.
 *
 * Chains operations where the output of one step feeds the input of the next.
 * Each step references previous results via 'result:field' in its input mapping.
 */
import type { PipeOpConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';

type AdapterWithOps = EntityAdapter<unknown, unknown, unknown> & Record<string, unknown>;

function resolveInput(
  input: Record<string, string> | undefined,
  previousResult: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!input) return params;
  const resolved: Record<string, unknown> = { ...params };
  for (const [key, ref] of Object.entries(input)) {
    if (ref.startsWith('result:')) {
      const field = ref.slice(7);
      if (typeof previousResult === 'object' && previousResult !== null) {
        resolved[key] = (previousResult as Record<string, unknown>)[field];
      }
    } else if (ref.startsWith('param:')) {
      resolved[key] = params[ref.slice(6)];
    } else {
      resolved[key] = ref;
    }
  }
  return resolved;
}

/**
 * Build a pipe executor for a single-entity adapter.
 *
 * Executes `op.steps` sequentially. Each step calls a named operation on `adapter`,
 * passing a resolved input map built from:
 * - `param:x` references → resolved from the original `params` argument.
 * - `result:field` references → resolved from the previous step's return value.
 * - Literal string values → passed through unchanged.
 *
 * The return value of the final step is the overall pipe result. If a step
 * references an operation that does not exist on the adapter, an error is thrown
 * immediately.
 *
 * **Atomicity:** Steps execute sequentially in JavaScript. There is no transaction
 * wrapping — if a later step fails, earlier steps are not rolled back. Use
 * `op.transaction` for multi-step cross-entity atomic writes.
 *
 * @param op - Pipe operation config with a `steps` array. Each step has `op` (operation
 *   name on the adapter) and an optional `input` mapping of `outputKey → reference`.
 * @param adapter - The entity adapter whose named operations are called.
 * @returns An async function `(params) => Promise<unknown>` that returns the last
 *   step's result.
 * @throws If a step's `op` name is not a function on `adapter`.
 *
 * @example
 * ```ts
 * const executor = pipeExecutor(op, adapter);
 * const result = await executor({ userId: 'u1', amount: 50 });
 * ```
 */
export function pipeExecutor(
  op: PipeOpConfig,
  adapter: AdapterWithOps,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async params => {
    let previousResult: unknown = null;

    for (const step of op.steps) {
      const fn = adapter[step.op];
      if (typeof fn !== 'function') {
        throw new Error(`[pipe] Operation '${step.op}' not found on adapter`);
      }
      const input = resolveInput(step.input, previousResult, params);
      previousResult = await (fn as (input: Record<string, unknown>) => Promise<unknown>)(input);
    }

    return previousResult;
  };
}
