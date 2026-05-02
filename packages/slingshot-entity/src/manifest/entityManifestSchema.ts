/**
 * Entity Manifest Schema — Zod-validated, JSON-serializable entity definitions.
 *
 * This is the declarative format for defining entities + operations in plain JSON.
 * No TypeScript, no imports, no functions. Function references use the HandlerRef
 * pattern: { handler: "name", params?: {} }.
 *
 * Flow: JSON → validate → resolve → ResolvedEntityConfig + OperationConfig
 */
import { z } from 'zod';
import { entityChannelConfigSchema, entityRouteConfigSchema } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Handler reference (for custom ops)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a handler reference used in `custom` manifest operations.
 *
 * A handler ref names a handler registered in an `EntityHandlerRegistry` and
 * optionally passes static params that are forwarded to the factory at
 * resolution time.
 *
 * @example
 * ```ts
 * import { handlerRefSchema } from '@lastshotlabs/slingshot-entity';
 *
 * // Validating a raw custom-op config object:
 * const result = handlerRefSchema.safeParse({ handler: 'sendEmail', params: { from: 'no-reply@example.com' } });
 * if (result.success) {
 *   console.log(result.data.handler); // 'sendEmail'
 * }
 * ```
 */
export const handlerRefSchema = z.object({
  handler: z.string().describe('Handler name resolved from the entity handler registry.'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Static parameters forwarded to the resolved handler. Omit to call the handler without params.',
    ),
});

/**
 * A JSON-serializable reference to a named handler in an `EntityHandlerRegistry`.
 *
 * Used inside `custom` operations in a manifest so that function references
 * don't need to be inlined in the JSON. The handler is resolved at runtime via
 * `resolveEntityManifest()` or `parseAndResolveEntityManifest()`.
 *
 * @example
 * ```ts
 * import type { HandlerRef } from '@lastshotlabs/slingshot-entity';
 *
 * // Embedded in a manifest's custom operation:
 * const ref: HandlerRef = {
 *   handler: 'sendWelcomeEmail',
 *   params: { from: 'no-reply@example.com' },
 * };
 * ```
 */
export type HandlerRef = z.infer<typeof handlerRefSchema>;

/**
 * A runtime hook reference embedded in a manifest.
 *
 * Used for adapter transforms and manifest lifecycle hooks. The handler name is
 * resolved from the plugin's `manifestRuntime`.
 */
export const runtimeHookRefSchema = z.object({
  handler: z.string().describe('Runtime hook name resolved from manifestRuntime.'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Static parameters forwarded to the resolved runtime hook. Omit to call the hook without params.',
    ),
});

/** A JSON-serializable reference to a runtime hook registered in `manifestRuntime`. */
export type RuntimeHookRef = z.infer<typeof runtimeHookRefSchema>;

// ---------------------------------------------------------------------------
// Field definition
// ---------------------------------------------------------------------------

const fieldTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'enum',
  'json',
  'string[]',
]);

const fieldSchema = z.object({
  type: fieldTypeSchema.describe(
    'Field storage type. One of: string, number, integer, boolean, date, enum, json, string[].',
  ),
  optional: z
    .boolean()
    .optional()
    .describe(
      'Whether the field may be omitted when creating or updating records. Omit to require the field.',
    ),
  primary: z
    .boolean()
    .optional()
    .describe(
      'Whether the field is the entity primary key. Omit to treat the field as non-primary.',
    ),
  immutable: z
    .boolean()
    .optional()
    .describe('Whether the field becomes read-only after creation. Omit to allow updates.'),
  private: z
    .boolean()
    .optional()
    .describe(
      'Hide the field from generated API responses. The field is still stored, settable, and queryable internally; it just never appears on the wire.',
    ),
  format: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Additional format hint for renderer or validation tooling. Omit when the field has no special format.',
    ),
  default: z
    .union([
      z.literal('uuid'),
      z.literal('now'),
      z.literal('cuid'),
      z.string(),
      z.number(),
      z.boolean(),
    ])
    .optional()
    .describe(
      "Default value applied when the field is omitted. Use 'uuid', 'now', 'cuid', or a literal value. Omit to require the caller or runtime to supply a value.",
    ),
  onUpdate: z
    .literal('now')
    .optional()
    .describe(
      "Automatic update behavior for the field. Use 'now' to refresh the field timestamp on updates, or omit to leave it unchanged.",
    ),
  values: z
    .array(z.string())
    .optional()
    .describe('Allowed values when the field type is enum. Omit for non-enum fields.'), // for enum type
});

/**
 * A single field definition inside an entity manifest.
 *
 * This is the JSON-serializable equivalent of `FieldDef`. The `values` key
 * corresponds to `FieldDef.enumValues` and is only meaningful when
 * `type === 'enum'`.
 *
 * @example
 * ```ts
 * import type { ManifestField } from '@lastshotlabs/slingshot-entity';
 *
 * const idField: ManifestField = { type: 'string', primary: true, default: 'uuid' };
 * const statusField: ManifestField = { type: 'enum', values: ['draft', 'published', 'archived'] };
 * const createdAtField: ManifestField = { type: 'date', default: 'now' };
 * const monthField: ManifestField = { type: 'string', format: 'month' };
 * ```
 */
export type ManifestField = z.infer<typeof fieldSchema>;

// ---------------------------------------------------------------------------
// Index + relation definitions
// ---------------------------------------------------------------------------

const indexSchema = z.object({
  fields: z.array(z.string()).describe('Entity fields included in the index.'),
  direction: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction for the index. One of: asc, desc. Omit to use the storage default.'),
  unique: z
    .boolean()
    .optional()
    .describe('Whether the index enforces uniqueness. Omit to create a non-unique index.'),
});

const relationSchema = z.object({
  kind: z
    .enum(['belongsTo', 'hasMany', 'hasOne'])
    .describe('Relation type. One of: belongsTo, hasMany, hasOne.'),
  target: z.string().describe('Target entity name for the relation.'),
  foreignKey: z.string().describe('Foreign-key field used to join to the target entity.'),
  optional: z
    .boolean()
    .optional()
    .describe('Whether the relation may be absent. Omit to require the relation when applicable.'),
});

// ---------------------------------------------------------------------------
// Filter expression (JSON-serializable)
// ---------------------------------------------------------------------------

const filterValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({ $ne: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.object({ $gt: z.union([z.string(), z.number(), z.literal('now')]) }),
    z.object({ $gte: z.union([z.string(), z.number(), z.literal('now')]) }),
    z.object({ $lt: z.union([z.string(), z.number(), z.literal('now')]) }),
    z.object({ $lte: z.union([z.string(), z.number(), z.literal('now')]) }),
    z.object({ $in: z.array(z.union([z.string(), z.number()])) }),
    z.object({ $nin: z.array(z.union([z.string(), z.number()])) }),
    z.object({ $contains: z.string() }),
  ]),
);

const filterExpressionSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      $and: z.array(z.lazy(() => filterExpressionSchema)).optional(),
      $or: z.array(z.lazy(() => filterExpressionSchema)).optional(),
    })
    .catchall(filterValueSchema),
);

// ---------------------------------------------------------------------------
// Operation schemas — JSON-serializable versions of all 19 built-in op kinds
// (lookup, exists, transition, fieldUpdate, aggregate, computedAggregate,
// batch, upsert, search, collection, consume, derive, transaction, pipe,
// arrayPush, arrayPull, arraySet, increment)
// plus the escape hatch `custom`.
// ---------------------------------------------------------------------------

const lookupOpSchema = z.object({
  kind: z.literal('lookup').describe("Operation kind discriminator. Must be 'lookup'."),
  fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe('Field matchers used to locate records.'),
  returns: z.enum(['one', 'many']).describe('Lookup return mode. One of: one, many.'),
});

const existsOpSchema = z.object({
  kind: z.literal('exists').describe("Operation kind discriminator. Must be 'exists'."),
  fields: z
    .record(z.string(), z.string())
    .describe('Field matchers used to find candidate records.'),
  check: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Additional field checks applied after the lookup. Omit to check only field matches.',
    ),
});

const transitionOpSchema = z.object({
  kind: z.literal('transition').describe("Operation kind discriminator. Must be 'transition'."),
  field: z.string().describe('Field updated by the transition.'),
  from: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]),
  to: z
    .union([z.string(), z.number(), z.boolean()])
    .describe('Value written when the transition succeeds.'),
  match: z
    .record(z.string(), z.string())
    .describe('Field matchers used to locate the record to transition.'),
  set: z
    .record(z.string(), z.union([z.string(), z.literal('now')]))
    .optional()
    .describe(
      'Additional fields written when the transition succeeds. Omit to update only the transition field.',
    ),
  returns: z
    .enum(['entity', 'boolean'])
    .optional()
    .describe(
      'Transition return mode. One of: entity, boolean. Omit to use the operation default.',
    ),
});

const fieldUpdateOpSchema = z.object({
  kind: z.literal('fieldUpdate').describe("Operation kind discriminator. Must be 'fieldUpdate'."),
  match: z
    .record(z.string(), z.string())
    .describe('Field matchers used to locate the record to update.'),
  set: z.array(z.string()).describe('Fields the caller is allowed to update.'),
  partial: z
    .boolean()
    .optional()
    .describe(
      'Whether callers may submit only a subset of the allowed fields. Omit to use the operation default.',
    ),
  nullable: z
    .boolean()
    .optional()
    .describe('Whether the allowed fields may be set to null. Omit to use the operation default.'),
});

const groupByConfigSchema = z.object({
  field: z.string().describe('Field name to group by.'),
  truncate: z
    .enum(['year', 'month', 'week', 'day', 'hour'])
    .optional()
    .describe(
      'Truncate date values to this granularity before grouping. ' +
        'E.g., "month" groups a date field into "2026-04", "2026-05", etc.',
    ),
});

const aggregateOpSchema = z.object({
  kind: z.literal('aggregate').describe("Operation kind discriminator. Must be 'aggregate'."),
  groupBy: z
    .union([z.string(), groupByConfigSchema])
    .optional()
    .describe(
      'Field or config used to group aggregate results. ' +
        'String form groups by exact field values. ' +
        'Object form { field, truncate? } optionally truncates dates before grouping. ' +
        'Omit to compute a single aggregate result set.',
    ),
  compute: z
    .record(z.string(), z.unknown())
    .describe('Aggregate expressions keyed by output field name.'),
  filter: filterExpressionSchema
    .optional()
    .describe('Filter expression applied before aggregation. Omit to aggregate over all records.'),
});

const computedAggregateOpSchema = z.object({
  kind: z.literal('computedAggregate'),
  source: z.string(),
  target: z.string(),
  sourceFilter: filterExpressionSchema,
  compute: z.record(z.string(), z.unknown()),
  materializeTo: z.string(),
  deriveFields: z
    .record(z.string(), z.object({ fn: z.string(), args: z.array(z.string()) }))
    .optional(),
  targetMatch: z.record(z.string(), z.string()),
  atomic: z.boolean().optional(),
});

const batchOpSchema = z.object({
  kind: z.literal('batch').describe("Operation kind discriminator. Must be 'batch'."),
  action: z.enum(['update', 'delete']).describe('Batch action. One of: update, delete.'),
  filter: filterExpressionSchema.describe(
    'Filter expression selecting records affected by the batch operation.',
  ),
  set: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Field values written during a batch update. Omit for delete actions.'),
  atomic: z
    .boolean()
    .optional()
    .describe(
      'Whether the batch operation must succeed atomically. Omit to use the adapter default.',
    ),
  returns: z
    .enum(['count', 'void'])
    .optional()
    .describe('Batch return mode. One of: count, void. Omit to use the operation default.'),
});

const upsertOpSchema = z.object({
  kind: z.literal('upsert').describe("Operation kind discriminator. Must be 'upsert'."),
  match: z
    .array(z.string())
    .describe(
      'Fields used to find an existing record before deciding whether to insert or update.',
    ),
  set: z.array(z.string()).describe('Fields the caller may write during the upsert.'),
  onCreate: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Additional field values written only when a new record is created. Omit to use only caller-provided values.',
    ),
  returns: z
    .union([z.literal('entity'), z.object({ entity: z.literal(true), created: z.literal(true) })])
    .optional()
    .describe('Upsert return payload mode. Omit to use the operation default.'),
});

const searchOpSchema = z.object({
  kind: z.literal('search').describe("Operation kind discriminator. Must be 'search'."),
  fields: z.array(z.string()).describe('Entity fields searched by the operation.'),
  filter: filterExpressionSchema
    .optional()
    .describe('Filter expression applied before searching. Omit to search across all records.'),
  paginate: z
    .boolean()
    .optional()
    .describe(
      'Whether the operation returns paginated results. Omit to use the operation default.',
    ),
});

const collectionOpSchema = z.object({
  kind: z.literal('collection').describe("Operation kind discriminator. Must be 'collection'."),
  parentKey: z.string().describe('Field on the parent entity that owns the collection.'),
  itemFields: z
    .record(z.string(), fieldSchema)
    .describe('Schema for items stored inside the collection.'),
  operations: z
    .array(z.enum(['list', 'add', 'remove', 'update', 'set']))
    .describe(
      'Collection actions exposed by the operation. One or more of: list, add, remove, update, set.',
    ),
  identifyBy: z
    .string()
    .optional()
    .describe(
      'Field used to uniquely identify items inside the collection. Omit to use the collection default identifier strategy.',
    ),
  maxItems: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Maximum number of items allowed in the collection. Omit to leave the collection unbounded.',
    ),
});

const consumeOpSchema = z.object({
  kind: z.literal('consume').describe("Operation kind discriminator. Must be 'consume'."),
  filter: filterExpressionSchema.describe('Filter expression selecting the record to consume.'),
  returns: z.enum(['boolean', 'entity']).describe('Consume return mode. One of: boolean, entity.'),
  expiry: z
    .object({
      field: z.string().describe('Field containing the consumption expiry timestamp or marker.'),
    })
    .optional()
    .describe(
      'Expiry configuration for consumable records. Omit when consumption does not depend on expiry.',
    ),
});

const deriveOpSchema = z.object({
  kind: z.literal('derive'),
  sources: z.array(
    z.object({
      from: z.string(),
      where: z.record(z.string(), z.union([z.string(), z.null()])),
      select: z.string().optional(),
      traverse: z
        .object({
          to: z.string(),
          on: z.string(),
          select: z.string(),
        })
        .optional(),
    }),
  ),
  merge: z.enum(['union', 'concat', 'intersect', 'first', 'priority']),
  flatten: z.boolean().optional(),
  postFilter: filterExpressionSchema.optional(),
});

const arrayPushOpSchema = z.object({
  kind: z.literal('arrayPush').describe("Operation kind discriminator. Must be 'arrayPush'."),
  field: z.string().describe('Array field updated by the operation.'),
  value: z.string().describe('Expression or parameter supplying the array item to append.'),
  dedupe: z
    .boolean()
    .optional()
    .describe(
      'Whether duplicate items are removed when pushing. Omit to use the operation default.',
    ),
});

const arrayPullOpSchema = z.object({
  kind: z.literal('arrayPull').describe("Operation kind discriminator. Must be 'arrayPull'."),
  field: z.string().describe('Array field updated by the operation.'),
  value: z.string().describe('Expression or parameter supplying the array item to remove.'),
});

const arraySetOpSchema = z.object({
  kind: z.literal('arraySet').describe("Operation kind discriminator. Must be 'arraySet'."),
  field: z.string().describe('Array field replaced by the operation.'),
  value: z.string().describe('Expression or parameter supplying the new array value.'),
  dedupe: z
    .boolean()
    .optional()
    .describe(
      'Whether duplicate items are removed when setting the array. Omit to use the operation default.',
    ),
});

const incrementOpSchema = z.object({
  kind: z.literal('increment').describe("Operation kind discriminator. Must be 'increment'."),
  field: z.string().describe('Numeric field incremented by the operation.'),
  by: z
    .number()
    .optional()
    .describe('Amount added to the field. Omit to use the operation default increment amount.'),
});

const transactionStepSchema = z.object({
  op: z.enum([
    'create',
    'update',
    'delete',
    'fieldUpdate',
    'transition',
    'batch',
    'arrayPush',
    'arrayPull',
    'lookup',
    'increment',
  ]),
  entity: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  match: z.record(z.string(), z.string()).optional(),
  set: z.record(z.string(), z.unknown()).optional(),
  field: z.string().optional(),
  from: z.union([z.string(), z.number(), z.boolean()]).optional(),
  to: z.union([z.string(), z.number(), z.boolean()]).optional(),
  action: z.enum(['update', 'delete']).optional(),
  filter: filterExpressionSchema.optional(),
  value: z.string().optional(),
  dedupe: z.boolean().optional(),
  by: z.number().optional(),
});

export const transactionOpSchema = z.object({
  kind: z.literal('transaction').describe("Operation kind discriminator. Must be 'transaction'."),
  steps: z.array(transactionStepSchema).describe('Ordered steps executed inside the transaction.'),
});

const pipeStepSchema = z.object({
  op: z.string(),
  config: z.record(z.string(), z.unknown()),
  input: z.record(z.string(), z.string()).optional(),
});

export const pipeOpSchema = z.object({
  kind: z.literal('pipe').describe("Operation kind discriminator. Must be 'pipe'."),
  steps: z.array(pipeStepSchema).describe('Ordered operations composed into the pipe.'),
});

const customOpHttpSchema = z.object({
  method: z
    .enum(['get', 'post', 'put', 'patch', 'delete'])
    .describe(
      'HTTP method used for the custom operation route. One of: get, post, put, patch, delete.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Explicit route path for the custom operation. Omit to use the entity plugin default custom-op path.',
    ),
});

const customOpSchema = z
  .object({
    kind: z.literal('custom'),
    /**
     * Named handler reference resolved from an `EntityHandlerRegistry`.
     * Required when the op has backend implementations. Omit for routing-only
     * markers (when `http` is set and no backend logic is needed).
     */
    handler: z.string().optional(),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Static parameters forwarded to the custom operation handler. Omit to call the handler without params.',
      ),
    /**
     * HTTP route metadata. When set, the entity plugin auto-mounts a route at
     * the declared method and path. When omitted, no route is auto-mounted.
     */
    http: customOpHttpSchema
      .optional()
      .describe(
        'HTTP route metadata for auto-mounted custom operation routes. Omit when the custom operation has no auto-mounted route.',
      ),
  })
  .refine(d => d.handler !== undefined || d.http !== undefined, {
    message:
      "Custom op must have either 'handler' (backend implementation) or 'http' (routing marker)",
  });

const operationSchema = z.discriminatedUnion('kind', [
  lookupOpSchema,
  existsOpSchema,
  transitionOpSchema,
  fieldUpdateOpSchema,
  aggregateOpSchema,
  computedAggregateOpSchema,
  batchOpSchema,
  upsertOpSchema,
  searchOpSchema,
  collectionOpSchema,
  consumeOpSchema,
  deriveOpSchema,
  transactionOpSchema,
  pipeOpSchema,
  customOpSchema,
  arrayPushOpSchema,
  arrayPullOpSchema,
  arraySetOpSchema,
  incrementOpSchema,
]);

/**
 * A discriminated union of all JSON-serializable operation configs.
 *
 * This is the manifest equivalent of `OperationConfig` — every supported
 * operation kind can be expressed in plain JSON without TypeScript functions.
 * `custom` operations use a `handler` string resolved via `EntityHandlerRegistry`.
 *
 * Supported kinds: `lookup`, `exists`, `transition`, `fieldUpdate`, `aggregate`,
 * `computedAggregate`, `batch`, `upsert`, `search`, `collection`, `consume`,
 * `derive`, `transaction`, `pipe`, `arrayPush`, `arrayPull`, `arraySet`,
 * `increment`, `custom`.
 *
 * @example
 * ```ts
 * import type { ManifestOperation } from '@lastshotlabs/slingshot-entity';
 *
 * const op: ManifestOperation = {
 *   kind: 'lookup',
 *   fields: { roomId: 'param:roomId' },
 *   returns: 'many',
 * };
 *
 * const pushOp: ManifestOperation = {
 *   kind: 'arrayPush',
 *   field: 'tags',
 *   value: 'param:tag',
 *   dedupe: true,
 * };
 *
 * const incrOp: ManifestOperation = {
 *   kind: 'increment',
 *   field: 'viewCount',
 *   by: 1,
 * };
 *
 * const customOp: ManifestOperation = {
 *   kind: 'custom',
 *   handler: 'sendWelcomeEmail',
 *   params: { from: 'no-reply@example.com' },
 * };
 * ```
 */
export type ManifestOperation = z.infer<typeof operationSchema>;

/**
 * HTTP routing metadata for a manifest `custom` operation.
 *
 * When declared on a custom op, the entity plugin auto-mounts a route at
 * `/{segment}/{opName}` (or the explicit `path`) using the declared method.
 */
export type ManifestCustomOpHttp = z.infer<typeof customOpHttpSchema>;

// ---------------------------------------------------------------------------
// autoGrant + activityLog configs
// ---------------------------------------------------------------------------

/**
 * Declares an automatic permission grant when an entity is created.
 *
 * On the entity's creation event, the framework calls
 * `permissionsAdapter.createGrant()` granting `role` to the user identified
 * by `subjectField` in the event payload.
 *
 * `resourceType` is derived from `routes.permissions.resourceType`.
 * `resourceId` defaults to `payload.id`. `tenantId` defaults to
 * `payload.orgId`.
 */
export const autoGrantConfigSchema = z.object({
  /**
   * The event shortname that triggers the grant.
   * Only `"created"` is supported in v1.
   */
  on: z.literal('created').describe("Event shortname that triggers the grant. Must be 'created'."),
  /** Role to grant (e.g. `"document:owner"`). */
  role: z.string().min(1).describe('Role granted when the trigger event fires.'),
  /** Payload field containing the subject's user ID (e.g. `"createdBy"`). */
  subjectField: z
    .string()
    .min(1)
    .describe('Payload field containing the subject ID that receives the grant.'),
  /**
   * Payload field name for the resource ID. When omitted, falls back to the
   * entity's primary key field name, then to `'id'`.
   */
  resourceIdField: z
    .string()
    .min(1)
    .optional()
    .describe('Payload field for the resource ID. Defaults to the entity PK field name.'),
  /**
   * Payload field name for the tenant ID. When omitted, falls back to the
   * entity's tenant field (from `tenant.field`), then to `'orgId'`.
   */
  tenantIdField: z
    .string()
    .min(1)
    .optional()
    .describe('Payload field for the tenant ID. Defaults to the entity tenant field or "orgId".'),
});

/**
 * Config for an automatic permission grant on entity creation.
 *
 * Declares which event triggers the grant, which role to assign, and which
 * payload fields to read the subject, resource, and tenant IDs from.
 * Field resolution follows a three-tier priority chain: explicit config
 * fields > resolved entity metadata > hardcoded defaults.
 *
 * @example
 * ```json
 * {
 *   "on": "created",
 *   "role": "project:owner",
 *   "subjectField": "createdBy",
 *   "resourceIdField": "projectId",
 *   "tenantIdField": "workspaceId"
 * }
 * ```
 */
export type AutoGrantConfig = z.infer<typeof autoGrantConfigSchema>;

/**
 * Per-event config for activity logging.
 */
export const activityEventConfigSchema = z.object({
  /** The `action` string written to the activity record. */
  action: z.string().min(1).describe('Action string written to the activity record.'),
  /**
   * Payload field names to capture as the `meta` object on the activity record.
   * When omitted or empty, `meta` is written as `null`.
   */
  meta: z
    .array(z.string())
    .optional()
    .describe(
      'Payload fields copied into the activity meta object. Omit or leave empty to store meta as null.',
    ),
});

/**
 * Config for a single activity log event entry.
 *
 * @example
 * ```json
 * { "action": "created", "meta": ["title", "status"] }
 * ```
 */
export type ActivityEventConfig = z.infer<typeof activityEventConfigSchema>;

/**
 * Declares automatic activity log writes for an entity's events.
 *
 * When any listed event fires, the framework calls `.create()` on the adapter
 * of the named sibling entity, writing `{ orgId, actorId, resourceType,
 * resourceId, action, meta }`.
 *
 * Field resolution follows a three-tier priority chain for each field:
 * - **Tenant ID**: `tenantIdField` > entity tenant field > `'orgId'`
 * - **Resource ID**: `resourceIdField` > entity PK field > `'id'`
 * - **Actor ID**: first match in `actorIdFields` > `['createdBy', 'updatedBy', 'actorId']` > `'system'`
 */
export const activityLogConfigSchema = z.object({
  /**
   * Entity key (from the manifest's `entities` map) whose adapter receives
   * the activity writes (e.g. `"Activity"`).
   */
  entity: z.string().min(1).describe('Entity key whose adapter receives the activity writes.'),
  /** Written as `resourceType` on every activity record. */
  resourceType: z.string().min(1).describe('Resource type written to every activity record.'),
  /**
   * Map of event shortname → activity config. Shortnames match the last
   * segment of the event key declared on the entity's routes (e.g.
   * `"statusChanged"` for `"content:document.statusChanged"`).
   */
  events: z
    .record(z.string(), activityEventConfigSchema)
    .describe('Event shortname to activity-log mapping for this entity.'),
  /**
   * Payload field name for the tenant ID. When omitted, falls back to the
   * entity's tenant field (from `tenant.field`), then to `'orgId'`.
   */
  tenantIdField: z
    .string()
    .min(1)
    .optional()
    .describe('Payload field for the tenant ID. Defaults to the entity tenant field or "orgId".'),
  /**
   * Payload field name for the resource ID. When omitted, falls back to the
   * entity's primary key field name, then to `'id'`.
   */
  resourceIdField: z
    .string()
    .min(1)
    .optional()
    .describe('Payload field for the resource ID. Defaults to the entity PK field name.'),
  /**
   * Payload field names to search for the actor ID, in priority order.
   * The first field found in the event payload is used. When omitted,
   * defaults to `['createdBy', 'updatedBy', 'actorId']`. Falls back to
   * `'system'` when no field matches.
   */
  actorIdFields: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Payload fields to search for the actor ID, in priority order. Defaults to ["createdBy", "updatedBy", "actorId"].',
    ),
});

/**
 * Config for declarative activity log writes on entity events.
 *
 * Declares which sibling entity receives the activity records, what resource
 * type to label them with, and how to resolve tenant, resource, and actor IDs
 * from event payloads. Field resolution follows a three-tier priority chain:
 * explicit config fields > resolved entity metadata > hardcoded defaults.
 *
 * @example
 * ```json
 * {
 *   "entity": "Activity",
 *   "resourceType": "project",
 *   "tenantIdField": "workspaceId",
 *   "events": {
 *     "created": { "action": "created" },
 *     "updated": { "action": "updated", "meta": ["title"] }
 *   }
 * }
 * ```
 */
export type ActivityLogConfig = z.infer<typeof activityLogConfigSchema>;

/** Runtime adapter transforms declared for an entity. */
export const adapterTransformsSchema = z.array(runtimeHookRefSchema).optional();

/** Root-level manifest lifecycle hooks. */
const manifestHooksObjectSchema = z.object({
  afterAdapters: z
    .array(runtimeHookRefSchema)
    .optional()
    .describe(
      'Runtime hooks executed after entity adapters are created. Omit to run no after-adapters hooks.',
    ),
});
export const manifestHooksSchema = manifestHooksObjectSchema.optional();

/**
 * Root-level manifest lifecycle hook config.
 *
 * Declares runtime hooks that execute at specific points during the entity
 * plugin lifecycle (e.g. after adapters are created).
 */
export type ManifestHooks = z.infer<typeof manifestHooksObjectSchema>;

// ---------------------------------------------------------------------------
// Entity manifest (single entity)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a complete single-entity manifest (with a `name` field).
 *
 * Use `validateEntityManifest()` to parse and validate raw JSON. The result
 * can be passed to `resolveEntityManifest()` to produce a `ResolvedEntityConfig`.
 *
 * @remarks
 * When embedding entities inside an app manifest's `entities` record the
 * entity name comes from the record key, not from the object itself. Use
 * `manifestEntitySchema` (which omits `name`) for that case.
 *
 * @example
 * ```ts
 * import { entityManifestSchema } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('message.manifest.json', 'utf-8'));
 * const result = entityManifestSchema.safeParse(raw);
 * if (result.success) {
 *   // Use result.data as EntityManifest
 * }
 * ```
 */
export const entityManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Entity name used for routes, storage, and generated identifiers.'),
  namespace: z
    .string()
    .optional()
    .describe(
      'Optional namespace prepended to entity event keys and generated identifiers. Omit to use the default namespace.',
    ),
  fields: z.record(z.string(), fieldSchema).describe('Field definitions keyed by field name.'),
  indexes: z
    .array(indexSchema)
    .optional()
    .describe('Additional indexes created for the entity. Omit to use only the implicit indexes.'),
  uniques: z
    .array(
      z.object({
        fields: z.array(z.string()).describe('Fields participating in the uniqueness constraint.'),
      }),
    )
    .optional()
    .describe(
      'Unique constraints enforced on combinations of fields. Omit to define no extra uniqueness constraints.',
    ),
  relations: z
    .record(z.string(), relationSchema)
    .optional()
    .describe('Entity relations keyed by relation name. Omit to define no relations.'),
  softDelete: z
    .union([
      z.object({
        field: z.string().describe('Field used to mark deleted records.'),
        value: z.string().describe('Literal value written when a record is soft-deleted.'),
      }),
      z.object({
        field: z.string().describe('Field used to mark deleted records.'),
        strategy: z.literal('non-null').describe("Soft-delete strategy. Must be 'non-null'."),
      }),
    ])
    .optional()
    .describe('Soft-delete strategy for the entity. Omit to use hard deletes.'),
  defaultSort: z
    .object({
      field: z.string().describe('Field used for the entity default sort order.'),
      direction: z.enum(['asc', 'desc']).describe('Default sort direction. One of: asc, desc.'),
    })
    .optional()
    .describe(
      'Default sort applied to list operations when no explicit sort is provided. Omit to use the adapter default order.',
    ),
  pagination: z
    .object({
      cursor: z
        .object({
          fields: z.array(z.string()).describe('Fields included in the pagination cursor.'),
        })
        .optional()
        .describe('Cursor pagination settings. Omit to use the entity default cursor behavior.'),
      defaultLimit: z
        .number()
        .optional()
        .describe('Default page size for paginated operations. Omit to use the framework default.'),
      maxLimit: z
        .number()
        .optional()
        .describe(
          'Maximum page size allowed for paginated operations. Omit to use the framework default.',
        ),
    })
    .optional()
    .describe('Pagination settings for the entity. Omit to use the framework defaults.'),
  tenant: z
    .object({
      field: z.string().describe('Field containing the tenant identifier for the entity.'),
      optional: z
        .boolean()
        .optional()
        .describe(
          'Whether records may omit the tenant field. Omit to require tenant values when tenancy is enabled.',
        ),
    })
    .optional()
    .describe(
      'Tenant-isolation settings for the entity. Omit to make the entity non-tenant-scoped.',
    ),
  ttl: z
    .object({
      defaultSeconds: z.number().describe('Default time-to-live in seconds for entity records.'),
    })
    .optional()
    .describe('TTL settings for automatically expiring records. Omit to disable TTL expiration.'),
  storage: z
    .object({
      memory: z
        .object({ maxEntries: z.number().describe('Maximum entries kept by the memory store.') })
        .optional()
        .describe(
          'Memory-store configuration. Omit when the entity does not use the memory store.',
        ),
      redis: z
        .object({ keyPrefix: z.string().describe('Redis key prefix used for the entity.') })
        .optional()
        .describe('Redis-store configuration. Omit when the entity does not use Redis.'),
      sqlite: z
        .object({ tableName: z.string().describe('SQLite table name used for the entity.') })
        .optional()
        .describe('SQLite-store configuration. Omit when the entity does not use SQLite.'),
      postgres: z
        .object({ tableName: z.string().describe('Postgres table name used for the entity.') })
        .optional()
        .describe('Postgres-store configuration. Omit when the entity does not use Postgres.'),
      mongo: z
        .object({
          collectionName: z.string().describe('Mongo collection name used for the entity.'),
        })
        .optional()
        .describe('Mongo-store configuration. Omit when the entity does not use MongoDB.'),
    })
    .optional()
    .describe('Per-store storage overrides for the entity. Omit to use the adapter defaults.'),
  operations: z
    .record(z.string(), operationSchema)
    .optional()
    .describe(
      'Entity operations keyed by operation name. Omit to use only the built-in CRUD operations.',
    ),
  routes: entityRouteConfigSchema
    .optional()
    .describe('Route-generation settings for the entity. Omit to use the entity plugin defaults.'),
  channels: entityChannelConfigSchema
    .optional()
    .describe(
      'Realtime channel settings for the entity. Omit to disable entity channel configuration.',
    ),
  /**
   * Override the URL path segment derived from the entity name.
   * Maps to `EntityPluginEntry.routePath`. When omitted, the segment is
   * auto-derived from the entity name (e.g. `Snapshot` → `snapshots`).
   */
  routePath: z
    .string()
    .optional()
    .describe(
      'URL path segment used for entity routes. Omit to auto-derive the segment from the entity name.',
    ),
  /**
   * Declares an automatic permission grant when this entity is created.
   *
   * On the entity's creation event, the framework calls
   * `permissionsAdapter.createGrant()` granting `role` to the user identified
   * by `subjectField` in the event payload. `resourceType` is derived from
   * `routes.permissions.resourceType`. `resourceId` defaults to `payload.id`.
   * `tenantId` defaults to `payload.orgId`.
   */
  autoGrant: autoGrantConfigSchema
    .optional()
    .describe(
      'Automatic permission grant emitted when the entity is created. Omit to disable auto-grants.',
    ),
  /**
   * Declares automatic activity log writes for this entity's events.
   *
   * When any listed event fires, the framework calls `.create()` on the
   * adapter of the named sibling entity, writing `{ orgId, actorId,
   * resourceType, resourceId, action, meta }`.
   */
  activityLog: activityLogConfigSchema
    .optional()
    .describe(
      'Automatic activity-log writes emitted for entity events. Omit to disable activity logging.',
    ),
  adapterTransforms: adapterTransformsSchema.describe(
    'Runtime adapter transforms applied to the entity. Omit to run no adapter transforms.',
  ),
});

/**
 * A complete, validated single-entity manifest object (includes the `name` field).
 *
 * Produced by `validateEntityManifest()` when validation succeeds. Pass to
 * `resolveEntityManifest()` to obtain a `ResolvedEntityConfig`.
 *
 * @example
 * ```ts
 * import { validateEntityManifest } from '@lastshotlabs/slingshot-entity';
 * import type { EntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = { name: 'Message', fields: { id: { type: 'string', primary: true, default: 'uuid' } } };
 * const { success, manifest } = validateEntityManifest(raw);
 * if (success) {
 *   const m: EntityManifest = manifest!;
 *   console.log(m.name); // 'Message'
 * }
 * ```
 */
export type EntityManifest = z.infer<typeof entityManifestSchema>;

// ---------------------------------------------------------------------------
// App-manifest embedding — same schema, but `name` moves to the record key
// ---------------------------------------------------------------------------
//
// The app manifest's `entities` section is a record keyed by entity name, so
// the entity object itself must NOT carry a `name` field. `manifestEntitySchema`
// is the canonical per-entity schema minus `name`, and `manifestEntitiesSchema`
// is the record form used inside the app manifest. This is the single source
// of truth — there is no second parallel schema hierarchy.

/**
 * Zod schema for a single entity definition inside an `entities` record,
 * where the entity name is the record key rather than a field on the object.
 *
 * This is `entityManifestSchema` with the `name` field omitted. Use this
 * schema to validate individual entity objects extracted from an app manifest's
 * `entities` section before passing them to `manifestToEntity()`.
 *
 * @example
 * ```ts
 * import { manifestEntitySchema } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = { fields: { id: { type: 'string', primary: true, default: 'uuid' } } };
 * const result = manifestEntitySchema.safeParse(raw);
 * if (result.success) {
 *   // Pass to manifestToEntity('Message', result.data)
 * }
 * ```
 */
export const manifestEntitySchema = entityManifestSchema.omit({ name: true });

/**
 * A single entity definition inside an `entities` record (no `name` field).
 *
 * Used when the app manifest's `entities` section keys entities by name.
 * Pass to `manifestToEntity(name, manifest)` to obtain a `ResolvedEntityConfig`.
 *
 * @example
 * ```ts
 * import { manifestToEntity } from '@lastshotlabs/slingshot-entity';
 * import type { ManifestEntity } from '@lastshotlabs/slingshot-entity';
 *
 * const entity: ManifestEntity = {
 *   fields: {
 *     id:   { type: 'string', primary: true, default: 'uuid' },
 *     body: { type: 'string' },
 *   },
 * };
 * const { config } = manifestToEntity('Message', entity);
 * console.log(config._storageName); // 'messages'
 * ```
 */
export type ManifestEntity = z.infer<typeof manifestEntitySchema>;

/**
 * Zod schema for the `entities` section of an app manifest —
 * a record mapping entity names to their definitions.
 *
 * Use this schema to validate the entire `entities` record from an app manifest
 * before passing it to `manifestEntitiesToConfigs()`.
 *
 * @example
 * ```ts
 * import { manifestEntitiesSchema } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('app-manifest.json', 'utf-8')).entities;
 * const result = manifestEntitiesSchema.safeParse(raw);
 * if (!result.success) {
 *   console.error(result.error.issues);
 * }
 * ```
 */
export const manifestEntitiesSchema = z.record(z.string(), manifestEntitySchema);

/**
 * The `entities` record from an app manifest, keyed by entity name.
 *
 * Pass to `manifestEntitiesToConfigs()` to resolve all entities at once.
 *
 * @example
 * ```ts
 * import { manifestEntitiesToConfigs } from '@lastshotlabs/slingshot-entity';
 * import type { ManifestEntities } from '@lastshotlabs/slingshot-entity';
 *
 * const entities: ManifestEntities = {
 *   Message: { fields: { id: { type: 'string', primary: true, default: 'uuid' }, body: { type: 'string' } } },
 *   Room:    { fields: { id: { type: 'string', primary: true, default: 'uuid' }, name: { type: 'string' } } },
 * };
 * const { entities: resolved } = manifestEntitiesToConfigs(entities);
 * ```
 */
export type ManifestEntities = z.infer<typeof manifestEntitiesSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The result of `validateEntityManifest()`.
 *
 * When `success` is `true`, `manifest` is the parsed and validated
 * `EntityManifest`. When `success` is `false`, `errors` contains structured
 * Zod validation issues.
 *
 * @example
 * ```ts
 * import { validateEntityManifest } from '@lastshotlabs/slingshot-entity';
 * import type { ManifestValidationResult } from '@lastshotlabs/slingshot-entity';
 *
 * const result: ManifestValidationResult = validateEntityManifest(raw);
 * if (result.success) {
 *   console.log('Valid manifest for entity:', result.manifest!.name);
 * } else {
 *   result.errors!.issues.forEach(i => console.error(`${i.path.join('.')}: ${i.message}`));
 * }
 * ```
 */
export interface ManifestValidationResult {
  success: boolean;
  manifest?: EntityManifest;
  errors?: z.ZodError;
}

/**
 * Parse and validate a raw value as a single-entity manifest.
 *
 * @param input - The raw value to validate (typically parsed JSON).
 * @returns A `ManifestValidationResult` — either `{ success: true, manifest }` or
 *   `{ success: false, errors }`.
 *
 * @example
 * ```ts
 * import { validateEntityManifest } from '@lastshotlabs/slingshot-entity';
 *
 * const raw = JSON.parse(fs.readFileSync('message.manifest.json', 'utf-8'));
 * const { success, manifest, errors } = validateEntityManifest(raw);
 * if (!success) {
 *   errors?.issues.forEach(i => console.error(`${i.path.join('.')}: ${i.message}`));
 * }
 * ```
 */
export function validateEntityManifest(input: unknown): ManifestValidationResult {
  const result = entityManifestSchema.safeParse(input);
  if (result.success) {
    return { success: true, manifest: result.data };
  }
  return { success: false, errors: result.error };
}
