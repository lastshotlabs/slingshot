import * as zodToOpenAPILib from '@asteasolutions/zod-to-openapi';
import { getRefId } from '@asteasolutions/zod-to-openapi';
import type { ResponseConfig } from '@asteasolutions/zod-to-openapi';
import { createRoute as _createRoute } from '@hono/zod-openapi';
import type { RouteConfig } from '@hono/zod-openapi';
import type { ZodType } from 'zod';

// ---------------------------------------------------------------------------
// Access the global OpenAPI registry via bracket notation to avoid triggering
// the @typescript-eslint/no-deprecated rule on the zodToOpenAPIRegistry export.
// The @deprecated annotation on zodToOpenAPIRegistry is self-described in the
// library source as "not really deprecated" — it is the correct and only stable
// low-level path for writing ref IDs to schemas that were created with a
// different zod instance (and thus cannot use .openapi() on them directly).
// ---------------------------------------------------------------------------
const zodOpenAPIRegistry = zodToOpenAPILib['zodToOpenAPIRegistry'];

// ---------------------------------------------------------------------------
// Local types for the registry's add() call — derived from the registry's
// own parameter types rather than the deprecated export's type annotation.
// ---------------------------------------------------------------------------

/** The schema parameter type expected by zodOpenAPIRegistry.add(). */
type RegistrySchemaArg = Parameters<typeof zodOpenAPIRegistry.add>[0];

/** The metadata parameter type expected by zodOpenAPIRegistry.add(). */
type RegistryMetadataArg = Parameters<typeof zodOpenAPIRegistry.add>[1];

/**
 * Maps HTTP status codes to the suffix appended when auto-generating OpenAPI schema names
 * for response bodies.
 *
 * When `createRoute` encounters an unnamed response schema for a known status code, it names
 * the schema `{Method}{PathSegments}{Suffix}` — e.g., `CreateLedgerItemsResponse` for 201,
 * or `GetLedgerItemsByIdNotFoundError` for 404. Status codes not present in this map fall back
 * to the raw numeric string as the suffix (e.g., `GetThingBy503`).
 */
const STATUS_SUFFIX: Record<string, string> = {
  '200': 'Response',
  '201': 'Response',
  '204': 'Response',
  '400': 'BadRequestError',
  '401': 'UnauthorizedError',
  '403': 'ForbiddenError',
  '404': 'NotFoundError',
  '409': 'ConflictError',
  '422': 'ValidationError',
  '429': 'RateLimitError',
  '500': 'InternalError',
  '501': 'NotImplementedError',
  '503': 'UnavailableError',
};

/**
 * Maps lowercase HTTP method strings to the PascalCase verb prefix used in auto-generated
 * OpenAPI schema names.
 *
 * `createRoute` prepends this verb when constructing schema names from a route's method and
 * path — e.g., `post` + `/ledger-items` → `CreateLedgerItems`. Methods not listed here
 * fall back to title-casing the raw method string (e.g., `OPTIONS` → `Options`).
 */
const METHOD_VERB: Record<string, string> = {
  get: 'Get',
  post: 'Create',
  put: 'Replace',
  patch: 'Update',
  delete: 'Delete',
};

/**
 * Converts an HTTP method and path into a PascalCase base name used for auto-generated
 * OpenAPI schema names.
 *
 * Algorithm:
 * 1. The method is looked up in `METHOD_VERB`; unknown methods are title-cased.
 * 2. The path is split on `/` and empty segments discarded.
 * 3. Path parameter segments (`{id}`, `{sessionId}`) become `By{ParamName}` in PascalCase.
 * 4. Plain and kebab-case segments are converted to PascalCase (`ledger-items` → `LedgerItems`).
 * 5. All segments are concatenated after the verb prefix.
 *
 * @param method - HTTP method string (case-insensitive, e.g. `'post'`, `'GET'`).
 * @param path - Route path string (e.g. `'/ledger-items/{id}'`).
 * @returns PascalCase base name (e.g. `'GetLedgerItemsById'`).
 *
 * @example
 * ```ts
 * toBaseName('post',   '/ledger-items')                 // → 'CreateLedgerItems'
 * toBaseName('get',    '/ledger-items/{id}')             // → 'GetLedgerItemsById'
 * toBaseName('delete', '/auth/sessions/{sessionId}')     // → 'DeleteAuthSessionsBySessionId'
 * toBaseName('patch',  '/org/{orgId}/members/{userId}')  // → 'UpdateOrgByOrgIdMembersByUserId'
 * ```
 */
function toBaseName(method: string, path: string): string {
  const m =
    METHOD_VERB[method.toLowerCase()] ??
    method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const segments = path
    .split('/')
    .filter(Boolean)
    .map(seg => {
      if (seg.startsWith('{') && seg.endsWith('}')) {
        const param = seg.slice(1, -1);
        return 'By' + param.charAt(0).toUpperCase() + param.slice(1);
      }
      // kebab-case and plain segments → PascalCase
      return seg
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        .replace(/^[a-z]/, c => c.toUpperCase());
    });
  return m + segments.join('');
}

/**
 * Registers an unnamed Zod schema in the global OpenAPI registry under the given `name`,
 * if it has not already been named.
 *
 * This is called internally by `createRoute` to ensure every request body and response
 * schema ends up in `components/schemas` rather than being inlined at each reference site.
 *
 * @param schema - The value extracted from a route config's body or response content. Any
 *   non-Zod value (falsy, non-object, missing `_def`) is silently skipped.
 * @param name - The ref ID to assign in the OpenAPI registry (e.g. `'CreateLedgerItemsRequest'`).
 *
 * @remarks
 * **Side effect:** mutates the singleton `zodOpenAPIRegistry` shared across the process.
 * This is intentional — the registry is global for OpenAPI schema collection, matching the
 * design of `@asteasolutions/zod-to-openapi`.
 *
 * Schemas already named via `.openapi("Name")` are detected via `getRefId` and skipped, so
 * manually named schemas are never overwritten by auto-generated names.
 *
 * The registry is written to directly (bypassing `.openapi()`) because `.openapi()` requires
 * `extendZodWithOpenApi()` to have been called on the same `zod` instance that created the
 * schema — which is not guaranteed in tenant app code that may use a different `zod` copy.
 */
function maybeRegister(schema: unknown, name: string): void {
  if (!schema || typeof schema !== 'object' || !('_def' in schema)) return;
  if (getRefId(schema as ZodType)) return; // already named via .openapi()
  // Write directly to the registry instead of calling schema.openapi(name) — the
  // .openapi() method requires extendZodWithOpenApi() to have been called on the
  // same zod instance that created the schema, which isn't guaranteed in tenant apps.
  const metadata: RegistryMetadataArg = { _internal: { refId: name } };
  zodOpenAPIRegistry.add(schema as unknown as RegistrySchemaArg, metadata);
}

/**
 * Registers a Zod schema as a named entry in `components/schemas`.
 *
 * Use this for shared schemas (e.g. shared error types, reusable response shapes)
 * that aren't directly attached to a specific route. Schemas already registered
 * under the same name are silently skipped.
 *
 * @example
 * export const MySchema = registerSchema("MySchema", z.object({ id: z.string() }));
 */
export const registerSchema = <T extends ZodType>(name: string, schema: T): T => {
  if (!getRefId(schema)) {
    const metadata: RegistryMetadataArg = { _internal: { refId: name } };
    zodOpenAPIRegistry.add(schema as unknown as RegistrySchemaArg, metadata);
  }
  return schema;
};

/**
 * Registers multiple Zod schemas at once as named entries in `components/schemas`.
 * Object keys become the schema names. Returns the same object so you can
 * destructure or re-export the schemas normally.
 *
 * Schemas already registered (e.g. via a prior `registerSchema` call) are skipped.
 *
 * @example
 * export const { LedgerItem, Product } = registerSchemas({
 *   LedgerItem: z.object({ id: z.string(), amount: z.number() }),
 *   Product:    z.object({ id: z.string(), price: z.number() }),
 * });
 */
export const registerSchemas = <T extends Record<string, ZodType>>(schemas: T): T => {
  for (const [name, schema] of Object.entries(schemas)) {
    if (!getRefId(schema)) {
      const metadata: RegistryMetadataArg = { _internal: { refId: name } };
      zodOpenAPIRegistry.add(schema as unknown as RegistrySchemaArg, metadata);
    }
  }
  return schemas;
};

/**
 * Auto-registers a module export as a named OpenAPI schema.
 * Used internally by modelSchemas auto-discovery in createApp.
 * Strips a trailing "Schema" suffix from the export name.
 * Skips non-Zod values and already-registered schemas.
 */
export function maybeAutoRegister(exportName: string, value: unknown): void {
  if (!value || typeof value !== 'object' || !('_def' in value)) return;
  if (getRefId(value as ZodType)) return;
  const name = exportName.endsWith('Schema') ? exportName.slice(0, -'Schema'.length) : exportName;
  const metadata: RegistryMetadataArg = { _internal: { refId: name } };
  zodOpenAPIRegistry.add(value as unknown as RegistrySchemaArg, metadata);
}

/**
 * Adds an OpenAPI `security` requirement to a route without affecting TypeScript
 * type inference on the handler. Pass each security scheme as a separate object.
 *
 * Use this instead of inlining `security` in `createRoute(...)` — inlining a
 * field typed as `{ [name: string]: string[] }` breaks `c.req.valid()` inference.
 *
 * @example
 * router.openapi(
 *   withSecurity(createRoute({ method: "get", path: "/me", ... }), { cookieAuth: [] }, { userToken: [] }),
 *   async (c) => { ... }
 * )
 */
export const withSecurity = <T extends RouteConfig>(
  route: T,
  ...schemes: Array<Record<string, string[]>>
): T => Object.assign(route, { security: schemes }) as T;

/**
 * Drop-in replacement for `createRoute` from `@hono/zod-openapi`.
 *
 * Automatically registers unnamed request body and response schemas as named
 * OpenAPI components so they appear in `components/schemas` instead of being
 * inlined at every use site. Generated names follow the convention:
 *
 *   {Method}{PathSegments}Request
 *   {Method}{PathSegments}{Status}
 *
 * Schemas already named via `.openapi("Name")` are never overwritten.
 */
export const createRoute = <T extends RouteConfig>(config: T): T => {
  const base = toBaseName(config.method, config.path);

  // Auto-name the JSON request body schema if present and unnamed
  const body = config.request?.body;
  const bodySchema = body?.content['application/json']?.schema;
  maybeRegister(bodySchema, `${base}Request`);

  // Auto-name each JSON response schema if present and unnamed
  for (const [status, response] of Object.entries(config.responses)) {
    const resSchema = (response as ResponseConfig).content?.['application/json']?.schema;
    maybeRegister(resSchema, `${base}${STATUS_SUFFIX[status] ?? status}`);
  }

  return _createRoute(config);
};
