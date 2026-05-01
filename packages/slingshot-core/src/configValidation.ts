import { z } from 'zod';
import { noopLogger } from './observability/logger';
import type { Logger } from './observability/logger';

/**
 * Build the standard `disableRoutes` Zod field for a plugin config schema.
 *
 * Produces a `z.array(z.enum([...values]))` schema that validates the `disableRoutes`
 * array in a plugin config. Pass `Object.values(MY_ROUTES)` as the allowed values.
 *
 * @param values - The complete set of valid route key strings (from a ROUTES constant).
 * @returns An optional Zod array schema typed to the provided enum values.
 *
 * @example
 * ```ts
 * import { disableRoutesSchema } from '@lastshotlabs/slingshot-core';
 *
 * const COMMUNITY_ROUTES = ['GET /posts', 'POST /posts', 'DELETE /posts/:id'] as const;
 *
 * const configSchema = z.object({
 *   disableRoutes: disableRoutesSchema(Object.values(COMMUNITY_ROUTES)),
 * });
 * ```
 */
export function disableRoutesSchema<T extends string>(values: readonly T[]) {
  return z.array(z.enum(values as [T, ...T[]])).optional();
}

/**
 * Log a warning for any unrecognised keys in a plugin config object.
 *
 * Compares the actual keys of `raw` against the keys declared in `schema.shape`.
 * Emits one `console.warn` per unknown key — does **not** throw. This is intentional:
 * unknown keys are most commonly typos that would silently have no effect, and surfacing
 * them as warnings catches mistakes early without crashing the server.
 *
 * @param pluginName - Plugin name used as the warning prefix (e.g. `'slingshot-community'`).
 * @param raw - The raw config object whose keys are checked.
 * @param schema - The Zod object schema whose `shape` keys define the known property set.
 * @param logger - Optional structured logger; defaults to no-op.
 * @returns `void` — all results are reported via the logger's `warn` level.
 *
 * @remarks
 * Because `validatePluginConfig` calls this after a successful `safeParse`, Zod's
 * `strip` mode has already silently dropped unknown keys from the parsed result.
 * This function exists to make those silent drops visible to developers — Zod itself
 * never warns about stripped keys.
 *
 * @example
 * ```ts
 * import { warnUnknownPluginKeys } from '@lastshotlabs/slingshot-core';
 *
 * const schema = z.object({ maxRetries: z.number() });
 * warnUnknownPluginKeys('slingshot-community', { maxRetries: 3, maxRtries: 3 }, schema);
 * // warn: [slingshot-community] Unknown config key "maxRtries" — will be ignored. Check for typos.
 * ```
 */
export function warnUnknownPluginKeys(
  pluginName: string,
  raw: Record<string, unknown>,
  schema: z.ZodObject,
  logger?: Logger,
): void {
  const log = logger ?? noopLogger;
  const known = new Set(Object.keys(schema.shape));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      log.warn(
        `[${pluginName}] Unknown config key "${key}" — will be ignored. Check for typos.`,
      );
    }
  }
}

/**
 * Validate that an adapter object implements all required method signatures.
 *
 * Checks that each name in `requiredMethods` exists on `adapter` and is a `function`.
 * Throws a single `Error` listing all absent or non-function properties if any are missing.
 *
 * @param pluginName - Plugin name used as the error prefix (e.g. `'slingshot-community'`).
 * @param adapterLabel - Human-readable path to the adapter in the config (e.g. `'permissions.adapter'`).
 *   Used in the error message so developers know exactly which config field is misconfigured.
 * @param adapter - The value to check. Accepted as `unknown` so callers need not cast.
 * @param requiredMethods - Names of methods that must be callable functions on `adapter`.
 * @returns `void` — only throws on failure.
 * @throws `Error` listing every missing method name if one or more are absent or not functions.
 *
 * @remarks
 * TypeScript interface types are erased at runtime. An adapter supplied as a plain config
 * value (e.g., a user-constructed object literal) may satisfy the TypeScript type while
 * missing methods at runtime — for example when transpiling with `isolatedModules` or
 * when the adapter arrives from a dynamic `require()`. This function enforces the contract
 * explicitly at server startup so failures are caught early with a clear message rather
 * than producing a cryptic `TypeError: x is not a function` inside a request handler.
 *
 * @example
 * ```ts
 * import { validateAdapterShape } from '@lastshotlabs/slingshot-core';
 *
 * validateAdapterShape('slingshot-community', 'permissions.adapter', adapter, [
 *   'createGrant', 'revokeGrant',
 * ]);
 * // throws: [slingshot-community] permissions.adapter is missing required methods: revokeGrant
 * ```
 */
export function validateAdapterShape(
  pluginName: string,
  adapterLabel: string,
  adapter: unknown,
  requiredMethods: string[],
): void {
  const obj = adapter as Record<string, unknown> | null | undefined;
  const missing = requiredMethods.filter(method => typeof obj?.[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `[${pluginName}] ${adapterLabel} is missing required methods: ${missing.join(', ')}`,
    );
  }
}

/**
 * Validate a plugin config object using its Zod schema.
 *
 * Parses `rawConfig` with `schema.safeParse`. On success, warns about unknown keys via
 * `warnUnknownPluginKeys` and returns the strongly-typed parsed config. On failure,
 * throws a formatted `Error` listing all Zod validation issues.
 *
 * The return type is derived directly from `schema` — no explicit type parameter is needed
 * at the call site.
 *
 * @param pluginName - Plugin name used in error messages and warnings (e.g. `'slingshot-community'`).
 * @param rawConfig - The raw, untyped config value as received from user-supplied app config.
 * @param schema - The Zod object schema that defines the expected config shape.
 * @returns The parsed config typed as `z.infer<S>`.
 * @throws `Error` with a bullet-list of all Zod issues if validation fails.
 *
 * @remarks
 * **try-catch / recovery behaviour:** `safeParse` is used instead of `parse` so that
 * _all_ validation issues can be collected and reported together in one error, rather than
 * halting on the first issue. There is no recovery from a validation failure — the error
 * is rethrown immediately and server startup aborts. Unknown keys are only warned about
 * (not thrown) so that future schema additions remain backwards-compatible.
 *
 * Unknown-key detection runs only when `rawConfig` is a non-null, non-array object.
 * Primitive or array configs pass through without unknown-key warnings.
 *
 * @example
 * ```ts
 * import { validatePluginConfig } from '@lastshotlabs/slingshot-core';
 *
 * const config = validatePluginConfig(
 *   'slingshot-community',
 *   rawConfig,
 *   communityConfigSchema,
 * );
 * // typeof config === z.infer<typeof communityConfigSchema>
 * ```
 */
export function validatePluginConfig<S extends z.ZodObject>(
  pluginName: string,
  rawConfig: unknown,
  schema: S,
  logger?: Logger,
): z.infer<S> {
  const result = schema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[${pluginName}] Invalid plugin config:\n${issues}`);
  }
  if (rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    warnUnknownPluginKeys(pluginName, rawConfig as Record<string, unknown>, schema, logger);
  }
  return result.data as z.infer<S>;
}
