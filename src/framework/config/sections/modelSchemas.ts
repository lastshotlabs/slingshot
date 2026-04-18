import { z } from 'zod';

/**
 * Zod schema for the `modelSchemas` section when supplied as a plain object
 * in `CreateAppConfig` / `CreateServerConfig`.
 *
 * `modelSchemas` controls how the framework discovers and registers generated
 * entity type-schemas (Zod schemas produced by `slingshot-entity`) at startup.
 * It can alternatively be supplied as a shorthand string or array of strings,
 * in which case the values are treated as glob paths and `registration` defaults
 * to `"auto"`.
 *
 * @remarks
 * **Fields:**
 * - `paths` — Glob pattern string, or array of glob patterns, pointing to the
 *   files that export model schemas. The framework uses these globs to
 *   dynamically `import()` every matched file at startup and collect exported
 *   Zod schemas. Example: `"src/entities/**\/schema.ts"`.
 * - `registration` — How schemas are registered after discovery:
 *   - `"auto"` (default) — Every Zod schema exported from a matched file is
 *     registered automatically without any manual call.
 *   - `"explicit"` — Only schemas that call `registerModelSchema()` themselves
 *     are registered; discovery still runs, but auto-registration is skipped.
 *     Use this when you want fine-grained control over which schemas appear in
 *     the schema registry.
 *
 * **Shorthand forms (validated in `appConfigSchema` before reaching this schema):**
 * - `modelSchemas: "src/entities"` — treated as `{ paths: "src/entities" }`.
 * - `modelSchemas: ["src/a", "src/b"]` — treated as `{ paths: [...] }`.
 *
 * @example
 * ```ts
 * // Object form in CreateServerConfig:
 * modelSchemas: {
 *   paths: ['src/entities/**\/schema.ts'],
 *   registration: 'auto',
 * }
 *
 * // Shorthand string form:
 * modelSchemas: 'src/entities',
 * ```
 */
export const modelSchemasObjectSchema = z.object({
  paths: z.union([z.string(), z.array(z.string())]).optional(),
  registration: z.enum(['auto', 'explicit']).optional(),
});
