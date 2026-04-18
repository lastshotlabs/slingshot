import { z } from 'zod';

/**
 * Zod schema that accepts any JavaScript function.
 *
 * Used throughout config section schemas wherever a callback, hook, or handler
 * function is accepted as a config value (e.g. `onLog`, `keyGenerator`,
 * `normalizePath`, `formatError`). Validates that the value is callable at
 * parse time; does not validate the function's arity or return type.
 *
 * @remarks
 * This is the canonical function-value schema for all config sections. Never
 * inline `z.custom<Function>(...)` in a section schema — import this instead.
 *
 * @example
 * ```ts
 * import { fnSchema } from './shared';
 *
 * const mySchema = z.object({
 *   onEvent: fnSchema.optional(),
 * });
 * ```
 */
export const fnSchema = z.custom<(...args: unknown[]) => unknown>(v => typeof v === 'function', {
  message: 'Expected a function',
});
