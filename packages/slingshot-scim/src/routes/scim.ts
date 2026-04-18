import { z } from 'zod';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { createRoute, registerSchema } from '@lastshotlabs/slingshot-core';
import { createRouter } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import { type ScimListResponse, parseScimFilter, userRecordToScim } from '../lib/scim';
import { createScimAuth } from '../middleware/scimAuth';

const tags = ['SCIM'];

/**
 * Rate-limit options applied to SCIM read endpoints (`GET /scim/v2/Users`, etc.).
 * 100 requests per minute per client IP.
 */
const scimReadOpts = { windowMs: 60_000, max: 100 };

/**
 * Rate-limit options applied to SCIM write endpoints (`POST`, `PUT`, `PATCH`, `DELETE`).
 * 30 requests per minute per client IP.
 */
const scimWriteOpts = { windowMs: 60_000, max: 30 };

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

/**
 * Validates the request body for `POST /scim/v2/Users` (user provisioning).
 *
 * @remarks
 * Accepts either `userName` (an email address) or `emails[0].value` as the
 * user's primary email — at least one must be present for the route handler
 * to proceed. All fields are optional at the schema level to align with the
 * SCIM 2.0 protocol (RFC 7644 §3.3); the route handler enforces the email
 * requirement explicitly. `.passthrough()` allows unknown SCIM extension
 * attributes to pass validation without being stripped.
 * `name.givenName` and `name.familyName` are capped at 256 characters.
 */
const scimUserCreateSchema = z.looseObject({
  userName: z.email().optional(),
  emails: z.array(z.object({ value: z.email() })).optional(),
  name: z
    .object({
      givenName: z.string().max(256).optional(),
      familyName: z.string().max(256).optional(),
    })
    .optional(),
  displayName: z.string().max(256).optional(),
  externalId: z.string().max(256).optional(),
  active: z.boolean().optional(),
});

/**
 * Validates the request body for `PUT /scim/v2/Users/:id` (full user replace).
 *
 * @remarks
 * Extends `scimUserCreateSchema` with an optional `id` field. When `id` is
 * present in the body it must match the `id` path parameter — the route handler
 * rejects mismatches with HTTP 400. Like the create schema, `.passthrough()` is
 * inherited and unknown SCIM extension attributes are preserved.
 */
const scimUserReplaceSchema = scimUserCreateSchema.extend({
  id: z.string().max(256).optional(),
});

/**
 * Validates the request body for `PATCH /scim/v2/Users/:id` (SCIM PatchOp).
 *
 * @remarks
 * Conforms to the SCIM 2.0 PatchOp schema (RFC 7644 §3.5.2). `Operations` is
 * required and capped at 100 entries to prevent abuse. Each operation must have
 * an `op` string (max 50 chars); `path` and `value` are optional per the RFC.
 * `.passthrough()` on both the outer object and inner operations preserves
 * unknown SCIM extension attributes without validation errors.
 */
const scimPatchSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(
      z.looseObject({
        op: z.string().max(50),
        path: z.string().max(256).optional(),
        value: z.unknown(),
      }),
    )
    .max(100),
});

/**
 * Validates and documents the JSON shape returned for a single SCIM user.
 *
 * @remarks
 * Matches the SCIM 2.0 User resource schema
 * (`urn:ietf:params:scim:schemas:core:2.0:User`). `active` is always included.
 * `emails` entries carry a `primary` boolean flag. `.passthrough()` allows
 * additional SCIM extension attributes to be serialised without being stripped.
 */
const scimUserResponseSchema = z.looseObject({
  schemas: z.array(z.string()),
  id: z.string(),
  userName: z.string().optional(),
  displayName: z.string().optional(),
  externalId: z.string().optional(),
  name: z
    .object({
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      formatted: z.string().optional(),
    })
    .optional(),
  emails: z.array(z.object({ value: z.string(), primary: z.boolean() })).optional(),
  active: z.boolean(),
  meta: z
    .object({
      resourceType: z.literal('User'),
      created: z.string().optional(),
      lastModified: z.string().optional(),
    })
    .optional(),
});

/**
 * Validates the SCIM 2.0 `ListResponse` envelope returned by `GET /scim/v2/Users`.
 *
 * @remarks
 * Follows RFC 7644 §3.4.2. `startIndex` is 1-based per the SCIM spec.
 * `itemsPerPage` reflects the actual number of `Resources` returned on this
 * page, which may be less than the requested `count` on the last page.
 */
const scimListResponseSchema = z.object({
  schemas: z.array(z.string()),
  totalResults: z.number().int(),
  startIndex: z.number().int(),
  itemsPerPage: z.number().int(),
  Resources: z.array(scimUserResponseSchema),
});

const scimErrorSchema = registerSchema(
  'ScimError',
  z.object({
    schemas: z.array(z.literal('urn:ietf:params:scim:api:messages:2.0:Error')),
    status: z.string(),
    /** RFC 7644 §3.12 error type keyword (e.g. "invalidFilter"). */
    scimType: z.string().optional(),
    detail: z.string(),
  }),
);

/**
 * Validates query parameters for `GET /scim/v2/Users`.
 *
 * @remarks
 * Enforces SCIM 2.0 pagination conventions (RFC 7644 §3.4.2.4): `startIndex`
 * is 1-based and defaults to 1; `count` is capped at 200 and defaults to 100.
 * `filter` is an optional SCIM filter expression — only single-clause
 * `attr eq "value"` filters on `userName`, `externalId`, and `active` are
 * supported; compound expressions (AND/OR/NOT) are rejected by the route handler.
 */
const scimListQuerySchema = z.object({
  filter: z.string().optional(),
  startIndex: z.coerce.number().int().min(1).default(1),
  count: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Validates the `id` path parameter for single-user SCIM routes.
 *
 * @remarks
 * Enforces a 256-character maximum to prevent excessively long IDs from
 * reaching the adapter.
 */
const scimUserIdParamSchema = z.object({ id: z.string().max(256) });

/**
 * Validates the response shape for `GET /scim/v2/ServiceProviderConfig`.
 *
 * @remarks
 * Documents the server's SCIM 2.0 feature support level (RFC 7644 §5).
 * The current implementation declares: PATCH supported, bulk not supported,
 * filter supported (max 200 results), changePassword not supported,
 * sort not supported, ETag not supported.
 */
const scimServiceProviderConfigSchema = z.object({
  schemas: z.array(z.string()),
  patch: z.object({ supported: z.boolean() }),
  bulk: z.object({ supported: z.boolean(), maxOperations: z.number(), maxPayloadSize: z.number() }),
  filter: z.object({ supported: z.boolean(), maxResults: z.number() }),
  changePassword: z.object({ supported: z.boolean() }),
  sort: z.object({ supported: z.boolean() }),
  etag: z.object({ supported: z.boolean() }),
});

/**
 * Validates the response shape for `GET /scim/v2/ResourceTypes`.
 *
 * @remarks
 * Describes the resource types supported by this SCIM server (RFC 7644 §4).
 * Currently only `User` is declared. Each entry carries the resource type
 * name, endpoint path, and canonical SCIM schema URN.
 */
const scimResourceTypesSchema = z.object({
  schemas: z.array(z.string()),
  totalResults: z.number(),
  Resources: z.array(
    z.object({
      schemas: z.array(z.string()),
      id: z.string(),
      name: z.string(),
      endpoint: z.string(),
      schema: z.string(),
    }),
  ),
});

/**
 * Union of HTTP status codes that may accompany a SCIM error response in this router.
 * Constrained to status codes declared in the route response schemas.
 */
type ScimErrorStatus = 400 | 401 | 404 | 409 | 429 | 501 | 503;

/**
 * Constructs a typed SCIM 2.0 error body POJO compatible with `scimErrorSchema`.
 *
 * Used with `c.json(scimErrorBody(...), status)` in route handlers so that Hono
 * can verify the response shape against the declared OpenAPI route schema.
 *
 * @param status - The HTTP status code for the error response.
 * @param detail - Human-readable error detail string (RFC 7644 §3.12).
 * @param scimType - Optional RFC 7644 §3.12 SCIM error type keyword (e.g. `"invalidFilter"`).
 * @returns A POJO matching the `scimErrorSchema` Zod shape.
 */
function scimErrorBody(
  status: ScimErrorStatus,
  detail: string,
  scimType?: string,
): z.infer<typeof scimErrorSchema> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

function activeStateRequested(body: { active?: boolean }): boolean {
  return body.active !== undefined;
}

function patchTouchesActive(
  operations: Array<{ op: string; path?: string; value: unknown }>,
): boolean {
  return operations.some(op => {
    const opType = op.op.toLowerCase();
    if ((opType === 'replace' || opType === 'add') && op.path === 'active') return true;
    if (opType === 'remove' && op.path === 'active') return true;
    return (
      !op.path &&
      (opType === 'replace' || opType === 'add') &&
      typeof op.value === 'object' &&
      op.value !== null &&
      'active' in (op.value as Record<string, unknown>)
    );
  });
}

function parseScimActiveValue(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

/**
 * Shared OpenAPI error response declarations applied to every SCIM route.
 *
 * Covers 400 (invalid request parameters), 401 (unauthorized), 429 (rate limit
 * exceeded), and 503 (SCIM not configured). All error bodies conform to
 * `scimErrorSchema`.
 */
const scimCommonErrors = {
  400: {
    content: { 'application/json': { schema: scimErrorSchema } },
    description: 'Invalid request parameters.',
  },
  401: {
    content: { 'application/json': { schema: scimErrorSchema } },
    description: 'Unauthorized.',
  },
  429: {
    content: { 'application/json': { schema: scimErrorSchema } },
    description: 'Rate limit exceeded.',
  },
  503: {
    content: { 'application/json': { schema: scimErrorSchema } },
    description: 'SCIM not configured.',
  },
};

/**
 * OpenAPI error response declarations for SCIM write routes (`POST`, `PUT`,
 * `PATCH`, `DELETE`).
 *
 * Extends `scimCommonErrors` with a 501 (adapter method not supported) entry
 * for adapters that do not implement optional write operations.
 */
const scimWriteErrors = {
  ...scimCommonErrors,
  501: {
    content: { 'application/json': { schema: scimErrorSchema } },
    description: 'Adapter method not supported.',
  },
};

// ─── Route Definitions ───────────────────────────────────────────────────────

const listUsersRoute = createRoute({
  method: 'get',
  path: '/scim/v2/Users',
  summary: 'List/search SCIM users',
  tags,
  request: { query: scimListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: scimListResponseSchema } },
      description: 'SCIM user list.',
    },
    ...scimCommonErrors,
    501: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'Adapter method not supported.',
    },
  },
});

const getUserRoute = createRoute({
  method: 'get',
  path: '/scim/v2/Users/{id}',
  summary: 'Get a SCIM user by ID',
  tags,
  request: { params: scimUserIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: scimUserResponseSchema } },
      description: 'SCIM user.',
    },
    404: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'User not found.',
    },
    ...scimCommonErrors,
    501: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'Adapter method not supported.',
    },
  },
});

const createUserRoute = createRoute({
  method: 'post',
  path: '/scim/v2/Users',
  summary: 'Create/provision a SCIM user',
  tags,
  request: {
    body: { content: { 'application/json': { schema: scimUserCreateSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: scimUserResponseSchema } },
      description: 'User created.',
    },
    409: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'User already exists.',
    },
    ...scimWriteErrors,
  },
});

const replaceUserRoute = createRoute({
  method: 'put',
  path: '/scim/v2/Users/{id}',
  summary: 'Replace a SCIM user',
  tags,
  request: {
    params: scimUserIdParamSchema,
    body: { content: { 'application/json': { schema: scimUserReplaceSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: scimUserResponseSchema } },
      description: 'User replaced.',
    },
    404: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'User not found.',
    },
    ...scimWriteErrors,
  },
});

const patchUserRoute = createRoute({
  method: 'patch',
  path: '/scim/v2/Users/{id}',
  summary: 'Partially update a SCIM user (PatchOp)',
  tags,
  request: {
    params: scimUserIdParamSchema,
    body: { content: { 'application/json': { schema: scimPatchSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: scimUserResponseSchema } },
      description: 'User updated.',
    },
    404: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'User not found.',
    },
    ...scimWriteErrors,
  },
});

const deleteUserRoute = createRoute({
  method: 'delete',
  path: '/scim/v2/Users/{id}',
  summary: 'Deprovision a SCIM user',
  tags,
  request: { params: scimUserIdParamSchema },
  responses: {
    204: { description: 'User deprovisioned.' },
    404: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'User not found.',
    },
    ...scimCommonErrors,
  },
});

const serviceProviderConfigRoute = createRoute({
  method: 'get',
  path: '/scim/v2/ServiceProviderConfig',
  summary: 'SCIM service provider capabilities',
  tags,
  responses: {
    200: {
      content: { 'application/json': { schema: scimServiceProviderConfigSchema } },
      description: 'SCIM service provider configuration.',
    },
    401: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'Unauthorized.',
    },
  },
});

const resourceTypesRoute = createRoute({
  method: 'get',
  path: '/scim/v2/ResourceTypes',
  summary: 'SCIM resource type discovery',
  tags,
  responses: {
    200: {
      content: { 'application/json': { schema: scimResourceTypesSchema } },
      description: 'SCIM resource types.',
    },
    401: {
      content: { 'application/json': { schema: scimErrorSchema } },
      description: 'Unauthorized.',
    },
  },
});

/**
 * Subset of user profile fields that SCIM write operations may update.
 * Passed to `adapter.updateProfile()` after extracting values from the SCIM request body.
 */
type ProfileFields = {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
};

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * Creates the OpenAPIHono router for all SCIM 2.0 endpoints.
 *
 * Called internally by `createScimPlugin`. Exposed for advanced use cases where you need
 * to mount the SCIM router manually without the full plugin lifecycle.
 *
 * All routes require SCIM bearer token authentication via `createScimAuth`. Rate limiting
 * is applied: 100 req/min for reads, 30 req/min for writes (per client IP).
 *
 * @param runtime - The auth plugin's `AuthRuntimeContext`, used for adapter access,
 *   rate limiting, and config resolution.
 * @returns An OpenAPIHono router mounted at the caller's chosen path prefix.
 *
 * @example
 * ```ts
 * import { createScimRouter } from '@lastshotlabs/slingshot-scim';
 * import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
 *
 * // Advanced: mount manually without the plugin
 * app.route('/scim', createScimRouter(getAuthRuntimeContext(ctx)));
 * ```
 */
export function createScimRouter(runtime: AuthRuntimeContext) {
  const { adapter } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();

  // All SCIM routes require SCIM bearer auth
  router.use('/scim/v2/*', createScimAuth(runtime));

  // GET /scim/v2/Users — list/search users
  router.openapi(
    listUsersRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-read:${ip}`, scimReadOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      if (!adapter.listUsers)
        return c.json(scimErrorBody(501, 'Auth adapter does not support listUsers'), 501);

      const { filter, startIndex, count } = c.req.valid('query');

      const query = parseScimFilter(filter);
      if (query === null) {
        return c.json(
          scimErrorBody(
            400,
            'Filter uses unsupported syntax. Only single-clause "attr eq \\"value\\"" filters are supported (attributes: userName, externalId, active). Compound expressions (AND/OR/NOT) are not supported.',
            'invalidFilter',
          ),
          400,
        );
      }
      query.startIndex = Math.max(0, startIndex - 1); // SCIM is 1-based
      query.count = Math.min(count, 200);

      const { users, totalResults } = await adapter.listUsers(query);

      const response: ScimListResponse = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults,
        startIndex,
        itemsPerPage: users.length,
        Resources: users.map(u => userRecordToScim(u, config.userMapping)),
      };

      return c.json(response, 200);
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // GET /scim/v2/Users/:id — get a user
  router.openapi(
    getUserRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-read:${ip}`, scimReadOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      if (!adapter.getUser)
        return c.json(scimErrorBody(501, 'Auth adapter does not support getUser'), 501);

      const { id } = c.req.valid('param');
      const user = await adapter.getUser(id);
      if (!user) return c.json(scimErrorBody(404, 'User not found'), 404);

      const scimUser = userRecordToScim(
        {
          id,
          email: user.email,
          displayName: user.displayName,
          firstName: user.firstName,
          lastName: user.lastName,
          externalId: user.externalId,
          suspended: user.suspended ?? false,
          suspendedReason: user.suspendedReason,
        },
        config.userMapping,
      );

      return c.json(scimUser, 200);
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // POST /scim/v2/Users — create a user (provision)
  router.openapi(
    createUserRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-write:${ip}`, scimWriteOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      const body = c.req.valid('json');
      if (body.active === false && !adapter.setSuspended) {
        return c.json(
          scimErrorBody(501, 'Auth adapter does not support setting SCIM active state'),
          501,
        );
      }

      const email = body.userName ?? body.emails?.[0]?.value;
      if (!email) return c.json(scimErrorBody(400, 'userName is required'), 400);

      const existingByEmail = await adapter.findByEmail(email);
      if (existingByEmail) return c.json(scimErrorBody(409, 'User already exists'), 409);

      // Create user with a random placeholder password (SCIM users authenticate via SSO)
      const placeholderHash = await runtime.password.hash(crypto.randomUUID());
      const { id } = await adapter.create(email, placeholderHash);

      // Set profile fields
      if (adapter.updateProfile) {
        const fields: ProfileFields = {};
        if (body.name?.givenName) fields.firstName = body.name.givenName;
        if (body.name?.familyName) fields.lastName = body.name.familyName;
        if (body.displayName) fields.displayName = body.displayName;
        if (body.externalId) fields.externalId = body.externalId;
        if (Object.keys(fields).length > 0) await adapter.updateProfile(id, fields);
      }
      if (body.active === false) {
        const setSuspended = adapter.setSuspended;
        if (!setSuspended) {
          return c.json(
            scimErrorBody(501, 'Auth adapter does not support setting SCIM active state'),
            501,
          );
        }
        await setSuspended(id, true);
      }

      const scimUser = userRecordToScim(
        {
          id,
          email,
          displayName: body.displayName,
          firstName: body.name?.givenName,
          lastName: body.name?.familyName,
          externalId: body.externalId,
          suspended: body.active === false,
        },
        config.userMapping,
      );

      return c.json(scimUser, 201);
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // PUT /scim/v2/Users/:id — replace a user
  router.openapi(
    replaceUserRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-write:${ip}`, scimWriteOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      const { id: userId } = c.req.valid('param');
      const body = c.req.valid('json');

      // Validate id in body matches path param if provided
      if (body.id && body.id !== userId) {
        return c.json(scimErrorBody(400, 'id in body does not match path parameter'), 400);
      }
      if (activeStateRequested(body) && !adapter.setSuspended) {
        return c.json(
          scimErrorBody(501, 'Auth adapter does not support setting SCIM active state'),
          501,
        );
      }

      // Check existence before modifying to prevent dangling partial state
      const user = await adapter.getUser?.(userId);
      if (!user) return c.json(scimErrorBody(404, 'User not found'), 404);

      if (adapter.updateProfile) {
        const fields: ProfileFields = {};
        if (body.name?.givenName !== undefined) fields.firstName = body.name.givenName;
        if (body.name?.familyName !== undefined) fields.lastName = body.name.familyName;
        if (body.displayName !== undefined) fields.displayName = body.displayName;
        if (body.externalId !== undefined) fields.externalId = body.externalId;
        if (Object.keys(fields).length > 0) await adapter.updateProfile(userId, fields);
      }

      if (adapter.setSuspended && body.active !== undefined) {
        await adapter.setSuspended(userId, !body.active);
      }

      // Re-read user after modifications to return current state
      const updatedUser = (await adapter.getUser?.(userId)) ?? user;

      return c.json(
        userRecordToScim(
          {
            id: userId,
            email: updatedUser.email,
            displayName: updatedUser.displayName,
            firstName: updatedUser.firstName,
            lastName: updatedUser.lastName,
            externalId: updatedUser.externalId,
            suspended: updatedUser.suspended ?? false,
          },
          config.userMapping,
        ),
        200,
      );
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // PATCH /scim/v2/Users/:id — partial update
  router.openapi(
    patchUserRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-write:${ip}`, scimWriteOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      const { id: userId } = c.req.valid('param');
      const body = c.req.valid('json');

      const operations: Array<{ op: string; path?: string; value: unknown }> = body.Operations;
      if (patchTouchesActive(operations) && !adapter.setSuspended) {
        return c.json(
          scimErrorBody(501, 'Auth adapter does not support setting SCIM active state'),
          501,
        );
      }

      const existingUser = await adapter.getUser?.(userId);
      if (!existingUser) return c.json(scimErrorBody(404, 'User not found'), 404);

      for (const op of operations) {
        const opType = op.op.toLowerCase();

        if (opType === 'replace' || opType === 'add') {
          const value = op.value;
          if (op.path === 'active' && adapter.setSuspended) {
            // Coerce to strict boolean — string "false" must not be treated as truthy
            const active = parseScimActiveValue(value);
            if (active === null) {
              return c.json(scimErrorBody(400, 'active must be a boolean'), 400);
            }
            await adapter.setSuspended(userId, !active);
          } else if (
            !op.path &&
            typeof value === 'object' &&
            value !== null &&
            adapter.updateProfile
          ) {
            // Bulk replace — map SCIM fields to profile fields
            const v = value as Record<string, unknown>;
            const fields: ProfileFields = {};
            if (typeof v.displayName === 'string') fields.displayName = v.displayName;
            if (typeof v['name.givenName'] === 'string') fields.firstName = v['name.givenName'];
            if (typeof v['name.familyName'] === 'string') fields.lastName = v['name.familyName'];
            if (typeof v.externalId === 'string') fields.externalId = v.externalId;
            if (v.active !== undefined && adapter.setSuspended) {
              const bulkActive = parseScimActiveValue(v.active);
              if (bulkActive === null) {
                return c.json(scimErrorBody(400, 'active must be a boolean'), 400);
              }
              await adapter.setSuspended(userId, !bulkActive);
            }
            if (Object.keys(fields).length > 0) await adapter.updateProfile(userId, fields);
          }
        } else if (opType === 'remove' && op.path === 'active' && adapter.setSuspended) {
          await adapter.setSuspended(userId, true);
        }
      }

      const user = (await adapter.getUser?.(userId)) ?? existingUser;

      return c.json(
        userRecordToScim(
          {
            id: userId,
            email: user.email,
            displayName: user.displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            externalId: user.externalId,
            suspended: user.suspended ?? false,
          },
          config.userMapping,
        ),
        200,
      );
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // DELETE /scim/v2/Users/:id — deprovision
  router.openapi(
    deleteUserRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`scim-write:${ip}`, scimWriteOpts)) {
        return c.json(scimErrorBody(429, 'Too many requests'), 429);
      }
      const config = getConfig().scim;
      if (!config) return c.json(scimErrorBody(503, 'SCIM not configured'), 503);

      const { id: userId } = c.req.valid('param');

      // Check user exists before deprovisioning (RFC 7644 section 3.6 requires 404 for unknown resources).
      // The startup validator ensures getUser is present when SCIM is enabled.
      const getUser = adapter.getUser?.bind(adapter);
      if (!getUser) {
        return c.json(scimErrorBody(501, 'Auth adapter does not support getUser'), 501);
      }
      const user = await getUser(userId);
      if (!user) return c.json(scimErrorBody(404, 'User not found'), 404);

      const onDeprovision = config.onDeprovision ?? 'suspend';

      if (typeof onDeprovision === 'function') {
        await onDeprovision(userId);
      } else if (onDeprovision === 'delete') {
        if (!adapter.deleteUser) {
          return c.json(
            scimErrorBody(501, 'Auth adapter does not support SCIM delete deprovisioning'),
            501,
          );
        }
        {
          const sr = runtime.repos.session;
          const ss = await sr.getUserSessions(userId, runtime.config);
          await Promise.all(ss.map(s => sr.deleteSession(s.sessionId, runtime.config)));
        }
        await adapter.deleteUser(userId);
      } else {
        // Default: suspend
        if (!adapter.setSuspended) {
          return c.json(
            scimErrorBody(501, 'Auth adapter does not support SCIM suspend deprovisioning'),
            501,
          );
        }
        await adapter.setSuspended(userId, true, 'SCIM deprovisioned');
      }

      return c.body(null, 204);
    },
    (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json(scimErrorBody(400, detail), 400);
      }
    },
  );

  // Discovery endpoints
  router.openapi(serviceProviderConfigRoute, c => {
    return c.json(
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
      },
      200,
    );
  });

  router.openapi(resourceTypesRoute, c => {
    return c.json(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: 1,
        Resources: [
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id: 'User',
            name: 'User',
            endpoint: '/scim/v2/Users',
            schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
          },
        ],
      },
      200,
    );
  });

  return router;
}
