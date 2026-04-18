import type { PolicyDecision, PolicyInput, PolicyResolver } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for `definePolicyDispatch`.
 *
 * @typeParam TRecord - Entity record type.
 * @typeParam TInput  - Entity create/update input type.
 * @typeParam TKey    - Union of discriminator values (e.g.
 *   `'chat:message' | 'community:thread'`). Strongly-typed dispatch keys
 *   catch typos at compile time.
 */
export interface PolicyDispatchConfig<TRecord, TInput, TKey extends string = string> {
  /**
   * Extract the discriminator value from a policy input. Usually reads
   * a field off `input.record` or `input.input` (whichever is non-null
   * for the current op).
   *
   * Returning `undefined` triggers the `fallback` branch.
   */
  dispatch: (input: PolicyInput<TRecord, TInput>) => TKey | undefined;
  /**
   * Per-discriminator-value resolver. Adding a new consumer means adding
   * a new entry; no changes to existing entries.
   */
  handlers: Readonly<Record<TKey, PolicyResolver<TRecord, TInput>>>;
  /**
   * What to do when the dispatch returns an unregistered value.
   *
   * - `'deny'` (default) — return `{ allow: false, reason: 'unregistered source type' }`.
   * - `'allow'` — return `{ allow: true }`. Use with caution.
   * - A resolver function — call it with the full input.
   */
  fallback?: 'deny' | 'allow' | PolicyResolver<TRecord, TInput>;
}

/**
 * Compose a dispatched policy resolver from per-discriminator handlers.
 *
 * The returned function is a normal `PolicyResolver` and can be passed
 * directly to `registerEntityPolicy`.
 *
 * @example
 * ```ts
 * registerEntityPolicy(app, 'polls:sourcePolicy', definePolicyDispatch({
 *   dispatch: input => (input.record ?? input.input)?.sourceType,
 *   handlers: {
 *     'chat:message':     chatPollPolicy,
 *     'community:thread': communityPollPolicy,
 *   },
 *   fallback: 'deny',
 * }));
 * ```
 */
export function definePolicyDispatch<TRecord, TInput, TKey extends string = string>(
  config: PolicyDispatchConfig<TRecord, TInput, TKey>,
): PolicyResolver<TRecord, TInput> {
  const fallback = config.fallback ?? 'deny';
  return async (input: PolicyInput<TRecord, TInput>): Promise<boolean | PolicyDecision> => {
    const key = config.dispatch(input);
    if (key !== undefined && Object.prototype.hasOwnProperty.call(config.handlers, key)) {
      return config.handlers[key](input);
    }
    if (fallback === 'deny') {
      return { allow: false, reason: `no handler registered for dispatch key '${String(key)}'` };
    }
    if (fallback === 'allow') {
      return { allow: true };
    }
    return fallback(input);
  };
}
