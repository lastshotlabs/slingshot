/**
 * Audit trail for permission changes.
 *
 * Records every create / update / delete operation performed through a
 * `PermissionsAdapter` so that operators and compliance tooling can answer
 * "who changed what and when".
 *
 * The audit trail is opt-in: create an `AuditTrailStore`, then wrap your
 * adapter with `withAuditTrail()`.
 */

import type {
  EvaluationScope,
  Logger,
  PermissionGrant,
  PermissionsAdapter,
  SubjectRef,
} from '@lastshotlabs/slingshot-core';
import { noopLogger } from '@lastshotlabs/slingshot-core';

// ── Public Types ──────────────────────────────────────────────────────────────

/**
 * The kind of resource that was changed.
 *
 * Currently only `'grant'` is recorded by the built-in adapters. The type is
 * a union string to allow future extension without a breaking change.
 */
export type AuditResourceType = 'grant';

/**
 * The action that was performed on the resource.
 */
export type AuditAction = 'create' | 'update' | 'delete';

/**
 * A single audit trail entry recording one permission change.
 */
export interface AuditTrailEntry {
  /** Unique entry ID. */
  readonly id: string;
  /** When the change occurred. */
  readonly timestamp: Date;
  /** Identity that performed the change (user ID, service name, etc.). */
  readonly actor: string;
  /** What was done. */
  readonly action: AuditAction;
  /** The kind of resource that was changed. */
  readonly resourceType: AuditResourceType;
  /** Identifier of the resource that was changed (e.g. grant ID, subject ID). */
  readonly resourceId: string;
  /**
   * Structured representation of what changed.
   *
   * For creates: the full input that was used to create the resource.
   * For updates: a `{ before, after }`diff snapshot.
   * For deletes: a snapshot of what was removed.
   */
  readonly changes: Record<string, unknown>;
  /** Tenant scope of the change, or `null` for global grants. */
  readonly tenantId: string | null;
}

/**
 * Filter for querying audit trail entries.
 */
export interface AuditTrailFilter {
  actor?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  tenantId?: string | null;
  /** Only entries on or after this timestamp. */
  from?: Date;
  /** Only entries on or before this timestamp. */
  to?: Date;
  /** Maximum number of results. Defaults to 100. */
  limit?: number;
  /** Number of results to skip (for pagination). */
  offset?: number;
}

/**
 * Persistent store for audit trail entries.
 */
export interface AuditTrailStore {
  /**
   * Persist a new audit entry and return its generated ID.
   */
  record(entry: Omit<AuditTrailEntry, 'id' | 'timestamp'>): Promise<string>;

  /**
   * Query entries matching the given filter.
   *
   * When `filter` is omitted, returns all entries (subject to `limit`/`offset`).
   * Entries are returned in reverse-chronological order (newest first).
   */
  query(filter?: AuditTrailFilter): Promise<AuditTrailEntry[]>;
}

// ── In-Memory Store ───────────────────────────────────────────────────────────

/**
 * Options for {@link createMemoryAuditTrailStore}.
 */
export interface MemoryAuditTrailStoreOptions {
  /**
   * Maximum number of entries to retain in memory.
   *
   * When the store exceeds this limit the oldest entries are evicted.
   * Defaults to 10_000. Pass `Infinity` to disable eviction.
   */
  maxEntries?: number;
}

/**
 * Create an in-memory audit trail store.
 *
 * Data is lost on process restart. Suitable for development, testing, and
 * low-traffic single-process deployments.
 *
 * @example
 * ```ts
 * const store = createMemoryAuditTrailStore();
 * await store.record({
 *   actor: 'admin@example.com',
 *   action: 'create',
 *   resourceType: 'grant',
 *   resourceId: 'grant-abc',
 *   changes: { roles: ['editor'] },
 *   tenantId: 'tenant-1',
 * });
 * ```
 */
export function createMemoryAuditTrailStore(
  options?: MemoryAuditTrailStoreOptions,
): AuditTrailStore {
  const maxEntries = options?.maxEntries ?? 10_000;
  const entries: AuditTrailEntry[] = [];

  return {
    async record(entry): Promise<string> {
      const id = crypto.randomUUID();
      const full: AuditTrailEntry = {
        ...entry,
        id,
        timestamp: new Date(),
      };

      // Evict oldest when at capacity
      if (entries.length >= maxEntries) {
        entries.shift();
      }
      entries.push(full);

      return id;
    },

    async query(filter): Promise<AuditTrailEntry[]> {
      let result = entries.slice(); // copy, newest last

      if (filter?.actor !== undefined) {
        result = result.filter(e => e.actor === filter.actor);
      }
      if (filter?.action !== undefined) {
        result = result.filter(e => e.action === filter.action);
      }
      if (filter?.resourceType !== undefined) {
        result = result.filter(e => e.resourceType === filter.resourceType);
      }
      if (filter?.resourceId !== undefined) {
        result = result.filter(e => e.resourceId === filter.resourceId);
      }
      if (filter?.tenantId !== undefined) {
        result = result.filter(e => e.tenantId === filter.tenantId);
      }
      if (filter?.from !== undefined) {
        result = result.filter(e => e.timestamp >= filter.from!);
      }
      if (filter?.to !== undefined) {
        result = result.filter(e => e.timestamp <= filter.to!);
      }

      // Reverse-chronological (newest first)
      result.reverse();

      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 100;
      return result.slice(offset, offset + limit);
    },
  };
}

// ── Adapter Wrapper ───────────────────────────────────────────────────────────

/**
 * Options for {@link withAuditTrail}.
 */
export interface WithAuditTrailOptions {
  /**
   * Default actor identity to use for operations that do not carry their own
   * actor identifier (e.g. `deleteAllGrantsForSubject`,
   * `deleteAllGrantsOnResource`).
   *
   * Defaults to `'system'`.
   */
  defaultActor?: string;

  /**
   * Optional structured logger for operational warnings (e.g. when a
   * before-snapshot cannot be captured). Defaults to a no-op logger.
   */
  logger?: Logger;
}

/**
 * Wrap a `PermissionsAdapter` so that every mutation method records an audit
 * trail entry before performing the operation.
 *
 * The wrapped adapter's mutation methods are transparently proxied — callers
 * interact with it exactly as they would the bare adapter.
 *
 * @example
 * ```ts
 * const adapter = createMemoryPermissionsAdapter();
 * const auditStore = createMemoryAuditTrailStore();
 * const audited = withAuditTrail(adapter, auditStore);
 *
 * // All mutations are now recorded in auditStore
 * await audited.createGrant({ ... });
 * ```
 */
export function withAuditTrail(
  adapter: PermissionsAdapter,
  store: AuditTrailStore,
  options?: WithAuditTrailOptions,
): PermissionsAdapter {
  const defaultActor = options?.defaultActor ?? 'system';
  const logger: Logger = options?.logger ?? noopLogger;

  return {
    async createGrant(grant) {
      const id = await adapter.createGrant(grant);
      await store.record({
        actor: grant.grantedBy || defaultActor,
        action: 'create',
        resourceType: 'grant',
        resourceId: id,
        changes: grant as unknown as Record<string, unknown>,
        tenantId: grant.tenantId,
      });
      return id;
    },

    async revokeGrant(grantId, revokedBy, tenantScope, revokedReason) {
      const result = await adapter.revokeGrant(grantId, revokedBy, tenantScope, revokedReason);
      if (result) {
        // NOTE: The adapter contract does not expose getGrantById, so we cannot
        // snapshot the full grant record before revocation. Log a warning so
        // operators know the audit trail will be missing the "before" state for
        // this particular entry.
        logger.warn(
          '[slingshot-permissions] revokeGrant: unable to capture before-snapshot — adapter does not expose getGrantById',
          {
            event: 'audit_snapshot_missing',
            grantId,
            revokedBy,
          },
        );

        await store.record({
          actor: revokedBy || defaultActor,
          action: 'update',
          resourceType: 'grant',
          resourceId: grantId,
          changes: {
            before: null,
            after: {
              revokedBy,
              revokedAt: new Date(),
              revokedReason,
            },
          },
          tenantId: null,
        });
      }
      return result;
    },

    async getGrantsForSubject(subjectId, subjectType, scope) {
      return adapter.getGrantsForSubject(subjectId, subjectType, scope);
    },

    async getEffectiveGrantsForSubject(subjectId, subjectType, scope) {
      return adapter.getEffectiveGrantsForSubject(subjectId, subjectType, scope);
    },

    async listGrantHistory(subjectId, subjectType) {
      return adapter.listGrantHistory(subjectId, subjectType);
    },

    async listGrantsOnResource(resourceType, resourceId, tenantId, limit, offset) {
      return adapter.listGrantsOnResource(resourceType, resourceId, tenantId, limit, offset);
    },

    async createGrants(grantInputs) {
      const ids = await adapter.createGrants(grantInputs);

      for (let i = 0; i < grantInputs.length; i++) {
        const input = grantInputs[i];
        const grantId = ids[i];
        await store.record({
          actor: input.grantedBy || defaultActor,
          action: 'create',
          resourceType: 'grant',
          resourceId: grantId,
          changes: input as unknown as Record<string, unknown>,
          tenantId: input.tenantId,
        });
      }

      return ids;
    },

    async deleteAllGrantsForSubject(subject) {
      // Capture grants before deletion for the audit trail
      const before = await adapter.getGrantsForSubject(subject.subjectId, subject.subjectType);

      await adapter.deleteAllGrantsForSubject(subject);

      for (const grant of before) {
        await store.record({
          actor: defaultActor,
          action: 'delete',
          resourceType: 'grant',
          resourceId: grant.id,
          changes: grant as unknown as Record<string, unknown>,
          tenantId: grant.tenantId,
        });
      }
    },

    async deleteAllGrantsOnResource(resourceType, resourceId, tenantId) {
      // Capture grants before deletion for the audit trail
      const before = await adapter.listGrantsOnResource(resourceType, resourceId, tenantId);

      await adapter.deleteAllGrantsOnResource(resourceType, resourceId, tenantId);

      for (const grant of before) {
        await store.record({
          actor: defaultActor,
          action: 'delete',
          resourceType: 'grant',
          resourceId: grant.id,
          changes: grant as unknown as Record<string, unknown>,
          tenantId: grant.tenantId,
        });
      }
    },
  };
}
