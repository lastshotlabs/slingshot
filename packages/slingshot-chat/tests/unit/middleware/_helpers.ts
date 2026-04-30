import type { Context } from 'hono';

type DynamicContext = { set(key: string, value: unknown): void };

/**
 * Local widening cast for tests -- lets us set arbitrary context variables
 * without augmenting Hono's global ContextVariableMap.
 */
export function setVar(c: Context, key: string, value: unknown): void {
  (c as unknown as DynamicContext).set(key, value);
}
