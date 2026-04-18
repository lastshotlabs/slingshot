/**
 * Local widening cast for tests — lets us set arbitrary context variables
 * without augmenting Hono's global ContextVariableMap. Per engineering
 * rule 14: type widening stays local.
 */
export function setVar(c, key, value) {
  c.set(key, value);
}
