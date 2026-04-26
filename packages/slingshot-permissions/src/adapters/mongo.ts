import { Schema } from 'mongoose';
import { validateGrant } from '@lastshotlabs/slingshot-core';
import type {
  EvaluationScope,
  GrantEffect,
  PermissionGrant,
  SubjectRef,
  SubjectType,
  TestablePermissionsAdapter,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Lean document interface
// ---------------------------------------------------------------------------

/**
 * MongoDB document shape for a `PermissionGrant`.
 * `_id` is a UUID string rather than an `ObjectId` to align with the cross-adapter ID convention.
 */
export interface GrantDoc {
  _id: string; // UUID string — not ObjectId
  subjectId: string;
  subjectType: SubjectType;
  tenantId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  roles: string[];
  effect: GrantEffect;
  grantedBy: string;
  grantedAt: Date;
  reason: string | null;
  expiresAt: Date | null;
  revokedBy: string | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

// ---------------------------------------------------------------------------
// Filter interfaces
// ---------------------------------------------------------------------------

/**
 * Basic Mongoose query filter for grant documents.
 * All fields are optional; only provided fields are used in the query.
 *
 * @remarks
 * All fields are optional — omitting a field applies no constraint for that
 * attribute. Every field that **is** present must match the document (i.e.
 * conditions are combined with implicit AND semantics). For example,
 * `{ subjectId: 'u1', revokedAt: null }` matches only documents where
 * `subjectId` equals `'u1'` AND `revokedAt` is `null`.
 */
export interface GrantFilter {
  _id?: string;
  subjectId?: string;
  subjectType?: SubjectType;
  tenantId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  revokedAt?: null;
}

/**
 * A single element of the `$or` array used to filter out expired grants.
 *
 * Matches grants that either have no expiry (`expiresAt: null`) or whose
 * expiry is strictly after the current time (`expiresAt: { $gt: now }`).
 * The two variants are combined in a MongoDB `$or` clause so that both
 * non-expiring and still-valid grants are included in query results.
 */
type ExpiryCondition = { expiresAt: null } | { expiresAt: { $gt: Date } };
/**
 * One level in the scope cascade hierarchy used by `getEffectiveGrantsForSubject`.
 * Represents a (tenantId, resourceType, resourceId) specificity level.
 *
 * @remarks
 * A `null` value in any field acts as a wildcard that matches documents where
 * that column is also `null` (i.e. the grant is not scoped to a specific tenant,
 * resource type, or resource ID). For example,
 * `{ tenantId: null, resourceType: null, resourceId: null }` matches global grants
 * that apply across all tenants and resources.
 */
export interface CascadeLevel {
  tenantId: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

/**
 * Full Mongoose query type for grant lookups, extending `GrantFilter` with
 * expiry (`$or`) and cascade level (`$and`) conditions.
 */
export type GrantQuery = GrantFilter & {
  $or?: ExpiryCondition[];
  $and?: Array<{ $or: CascadeLevel[] }>;
};

// ---------------------------------------------------------------------------
// Model interface
// ---------------------------------------------------------------------------

/**
 * Chainable query object returned by `GrantsModel.find()`.
 * Supports skip/limit for pagination and lean() for raw document retrieval.
 */
export interface GrantsCursor {
  skip(n: number): this;
  limit(n: number): this;
  lean(): Promise<GrantDoc[]>;
}

/**
 * Minimal Mongoose model interface for the `PermissionGrant` collection.
 * Satisfied by a real Mongoose model; also useful for testing with mock objects.
 */
export interface GrantsModel {
  create(doc: GrantDoc): Promise<{ _id: string }>;
  insertMany(docs: GrantDoc[]): Promise<unknown>;
  findOneAndUpdate(
    filter: GrantFilter,
    update: { $set: Partial<GrantDoc> },
    opts: { new: boolean },
  ): Promise<GrantDoc | null>;
  find(filter: GrantQuery): GrantsCursor;
  deleteMany(filter: GrantQuery): Promise<{ deletedCount: number }>;
}

// ---------------------------------------------------------------------------
// Connection interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface satisfied by a Mongoose `Connection`.
 * Accepted by `createMongoPermissionsAdapter` to enable testing with mock connections.
 */
export interface MongoConnectionLike {
  model(name: string, schema: object): GrantsModel;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Mongoose schema for the `permission_grants` collection.
 *
 * Uses UUID strings as `_id` (not ObjectId) to maintain cross-adapter ID consistency.
 * Indexes are declared on `(subjectType, subjectId)`, `(resourceType, resourceId)`,
 * and `tenantId` to support the primary query patterns.
 *
 * @remarks
 * `timestamps: false` — `grantedAt` serves as the creation timestamp and is set
 * explicitly. `updatedAt` is not tracked because grants are never updated in place;
 * they are revoked via a `$set` on `revokedAt`.
 */
const grantSchema = new Schema<GrantDoc>(
  {
    _id: { type: String },
    subjectId: { type: String, required: true },
    subjectType: { type: String, required: true },
    tenantId: { type: String, default: null },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    roles: [{ type: String }],
    effect: { type: String, required: true, enum: ['allow', 'deny'] },
    grantedBy: { type: String, required: true },
    grantedAt: { type: Date, default: Date.now },
    reason: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: false, autoIndex: false },
);

grantSchema.index({ subjectType: 1, subjectId: 1, tenantId: 1 });
grantSchema.index({ resourceType: 1, resourceId: 1 });
grantSchema.index({ tenantId: 1 });

// ---------------------------------------------------------------------------
// Lean doc → domain type
// ---------------------------------------------------------------------------

/**
 * Converts a lean `GrantDoc` Mongoose document to a `PermissionGrant` domain object.
 *
 * Maps `_id` → `id`, replaces `null` fields with `undefined` for optional domain
 * properties, and passes `Date` fields through unchanged.
 *
 * @param doc - A lean `GrantDoc` returned by a Mongoose `.lean()` query.
 * @returns The fully-typed `PermissionGrant` domain object.
 *
 * @remarks
 * MongoDB stores optional fields as `null` in the document (per the schema defaults).
 * This function converts `null` → `undefined` for the optional domain properties
 * (`reason`, `expiresAt`, `revokedBy`, `revokedAt`) using the nullish coalescing
 * operator (`?? undefined`). Required fields (`tenantId`, `resourceType`, `resourceId`)
 * are passed through as `string | null` to preserve the domain type contract.
 */
function toGrant(doc: GrantDoc): PermissionGrant {
  return {
    id: doc._id,
    subjectId: doc.subjectId,
    subjectType: doc.subjectType,
    tenantId: doc.tenantId,
    resourceType: doc.resourceType,
    resourceId: doc.resourceId,
    roles: doc.roles,
    effect: doc.effect,
    grantedBy: doc.grantedBy,
    grantedAt: doc.grantedAt,
    reason: doc.reason ?? undefined,
    expiresAt: doc.expiresAt ?? undefined,
    revokedBy: doc.revokedBy ?? undefined,
    revokedAt: doc.revokedAt ?? undefined,
    revokedReason: doc.revokedReason ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Alias for `TestablePermissionsAdapter` returned by `createMongoPermissionsAdapter`.
 * Exposes the `clear()` method for resetting state in integration tests.
 */
export type PermissionsMongoAdapter = TestablePermissionsAdapter;

/**
 * Creates a MongoDB-backed `PermissionsAdapter` using a Mongoose connection.
 *
 * Registers a `PermissionGrant` model on the provided connection. UUID strings are used
 * as `_id` values (not ObjectIds). Indexes are declared in the schema for
 * `(subjectType, subjectId)`, `(resourceType, resourceId)`, and `tenantId`.
 *
 * @param conn - A Mongoose `Connection` (or compatible object implementing `MongoConnectionLike`).
 * @returns A `PermissionsMongoAdapter` instance, ready for use.
 *
 * @example
 * ```ts
 * import { createMongoPermissionsAdapter } from '@lastshotlabs/slingshot-permissions';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
 * const adapter = createMongoPermissionsAdapter(conn);
 * ```
 */
export function createMongoPermissionsAdapter(conn: MongoConnectionLike): PermissionsMongoAdapter {
  const Grant: GrantsModel = conn.model('PermissionGrant', grantSchema);

  return {
    async createGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string> {
      validateGrant(grant);
      const id = crypto.randomUUID();
      await Grant.create({
        _id: id,
        subjectId: grant.subjectId,
        subjectType: grant.subjectType,
        tenantId: grant.tenantId ?? null,
        resourceType: grant.resourceType ?? null,
        resourceId: grant.resourceId ?? null,
        roles: grant.roles,
        effect: grant.effect,
        grantedBy: grant.grantedBy,
        grantedAt: new Date(),
        reason: grant.reason ?? null,
        expiresAt: grant.expiresAt ?? null,
        revokedBy: null,
        revokedAt: null,
        revokedReason: null,
      });
      return id;
    },

    async revokeGrant(
      grantId: string,
      revokedBy: string,
      tenantScope?: string,
      revokedReason?: string,
    ): Promise<boolean> {
      if (revokedReason !== undefined && revokedReason.length > 1024) {
        throw new Error('revokedReason exceeds maximum length of 1024');
      }
      const filter: GrantFilter = { _id: grantId, revokedAt: null };
      if (tenantScope !== undefined) filter.tenantId = tenantScope;
      const $set: Partial<GrantDoc> = { revokedBy, revokedAt: new Date() };
      if (revokedReason !== undefined) $set.revokedReason = revokedReason;
      const result = await Grant.findOneAndUpdate(filter, { $set }, { new: false });
      return result !== null;
    },

    async getGrantsForSubject(
      subjectId: string,
      subjectType?: SubjectType,
      scope?: Partial<Pick<PermissionGrant, 'tenantId' | 'resourceType' | 'resourceId'>>,
    ): Promise<PermissionGrant[]> {
      const filter: GrantFilter = { subjectId, revokedAt: null };
      if (subjectType !== undefined) filter.subjectType = subjectType;
      if (scope !== undefined) {
        if (scope.tenantId !== undefined) filter.tenantId = scope.tenantId;
        if (scope.resourceType !== undefined) filter.resourceType = scope.resourceType;
        if (scope.resourceId !== undefined) filter.resourceId = scope.resourceId;
      }
      const now = new Date();
      const query: GrantQuery = {
        ...filter,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };
      const docs = await Grant.find(query).lean();
      return docs.map(toGrant);
    },

    async listGrantHistory(
      subjectId: string,
      subjectType: SubjectType,
    ): Promise<PermissionGrant[]> {
      const docs = await Grant.find({ subjectId, subjectType }).lean();
      return docs.map(toGrant);
    },

    async getEffectiveGrantsForSubject(
      subjectId: string,
      subjectType: SubjectType,
      scope?: EvaluationScope,
    ): Promise<PermissionGrant[]> {
      const tenantId = scope?.tenantId;
      const resourceType = scope?.resourceType;
      const resourceId = scope?.resourceId;

      const cascadeLevels: CascadeLevel[] = [
        { tenantId: null, resourceType: null, resourceId: null },
      ];
      if (tenantId !== undefined) {
        cascadeLevels.push({ tenantId, resourceType: null, resourceId: null });
        if (resourceType !== undefined) {
          cascadeLevels.push({ tenantId, resourceType, resourceId: null });
          if (resourceId !== undefined) {
            cascadeLevels.push({ tenantId, resourceType, resourceId });
          }
        }
      }

      const now = new Date();
      const query: GrantQuery = {
        subjectId,
        subjectType,
        revokedAt: null,
        $and: [{ $or: cascadeLevels }],
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };
      const docs = await Grant.find(query).lean();
      return docs.map(toGrant);
    },

    async listGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
      limit?: number,
      offset?: number,
    ): Promise<PermissionGrant[]> {
      const filter: GrantFilter = { resourceType, resourceId, revokedAt: null };
      if (tenantId !== undefined) filter.tenantId = tenantId;
      const now = new Date();
      const query: GrantQuery = {
        ...filter,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };
      let cursor = Grant.find(query);
      if (offset !== undefined && offset > 0) cursor = cursor.skip(offset);
      if (limit !== undefined) cursor = cursor.limit(limit);
      const docs = await cursor.lean();
      return docs.map(toGrant);
    },

    async createGrants(
      grantInputs: Omit<PermissionGrant, 'id' | 'grantedAt'>[],
    ): Promise<string[]> {
      for (const g of grantInputs) validateGrant(g);
      const docs: GrantDoc[] = grantInputs.map(grant => ({
        _id: crypto.randomUUID(),
        subjectId: grant.subjectId,
        subjectType: grant.subjectType,
        tenantId: grant.tenantId ?? null,
        resourceType: grant.resourceType ?? null,
        resourceId: grant.resourceId ?? null,
        roles: grant.roles,
        effect: grant.effect,
        grantedBy: grant.grantedBy,
        grantedAt: new Date(),
        reason: grant.reason ?? null,
        expiresAt: grant.expiresAt ?? null,
        revokedBy: null,
        revokedAt: null,
        revokedReason: null,
      }));
      await Grant.insertMany(docs);
      return docs.map(d => d._id);
    },

    async deleteAllGrantsForSubject(subject: SubjectRef): Promise<void> {
      await Grant.deleteMany({ subjectId: subject.subjectId, subjectType: subject.subjectType });
    },

    async deleteAllGrantsOnResource(
      resourceType: string,
      resourceId: string,
      tenantId?: string | null,
    ): Promise<void> {
      const filter: GrantFilter = { resourceType, resourceId };
      if (tenantId !== undefined) filter.tenantId = tenantId;
      await Grant.deleteMany(filter);
    },

    async clear(): Promise<void> {
      await Grant.deleteMany({});
    },
  };
}
