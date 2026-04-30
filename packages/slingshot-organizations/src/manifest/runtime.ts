import { createHash, randomBytes } from 'crypto';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type { OperationIdempotencyAdapter } from '@lastshotlabs/slingshot-core';
import {
  createMemoryOperationIdempotencyAdapter,
  makeIdempotencyKey,
} from '@lastshotlabs/slingshot-core';
import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityAdapterTransformRegistry,
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { SlugConflictError, isUniqueViolationError } from '../errors';
import type { OrganizationsAuthRuntime } from '../lib/authRuntime';
import type { ReconcileOrphanedOrgRecordsResult } from '../reconcile';

/**
 * Structured-log helper for the package. Writes a single JSON line tagged
 * with the package prefix so log aggregators can group all
 * `slingshot-organizations` events. Keeps the same on-disk shape regardless
 * of which call site emits the event.
 */
function logError(event: string, context: Record<string, unknown>, error: unknown): void {
  const errorPayload =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
  console.error(
    `[slingshot-organizations] ${event} ${JSON.stringify({
      level: 'error',
      pkg: 'slingshot-organizations',
      event,
      ...context,
      error: errorPayload,
    })}`,
  );
}

type MemberRole = string;

export const DEFAULT_KNOWN_MEMBER_ROLES: ReadonlyArray<string> = ['owner', 'admin', 'member'];

type OrganizationRecord = {
  id: string;
  tenantId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  logoUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrganizationMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  invitedBy?: string | null;
};

type OrganizationInviteRecord = {
  id: string;
  orgId: string;
  invitedBy: string;
  email?: string | null;
  userId?: string | null;
  tokenHash: string;
  role: MemberRole;
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
};

type AdapterRefs = {
  organizations?: BareEntityAdapter;
  members?: BareEntityAdapter;
  invites?: BareEntityAdapter;
  groups?: BareEntityAdapter;
  groupMemberships?: BareEntityAdapter;
};

type InviteRuntimeAdapter = BareEntityAdapter & {
  findPendingByToken(rawToken: string): Promise<OrganizationInviteRecord | null>;
  reveal(id: string): Promise<OrganizationInviteRecord | null>;
};

/**
 * Optional batch-fetch capability that adapters can implement to short-circuit
 * `listMine`'s N+1 lookups. When unavailable the runtime falls back to parallel
 * `getById()` calls.
 */
type OrganizationsBatchFetchAdapter = BareEntityAdapter & {
  listByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<OrganizationRecord | null>>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeDateValue(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function hasMethod(value: BareEntityAdapter, method: string): boolean {
  return typeof value[method] === 'function';
}

function requireMethod(value: BareEntityAdapter, method: string): BareEntityAdapter {
  if (!hasMethod(value, method)) {
    throw new Error(`[slingshot-organizations] adapter is missing required method '${method}'`);
  }
  return value;
}

function sanitizeInvite(
  invite: OrganizationInviteRecord,
  rawToken?: string,
): Record<string, unknown> {
  return {
    id: invite.id,
    orgId: invite.orgId,
    invitedBy: invite.invitedBy,
    email: invite.email ?? undefined,
    userId: invite.userId ?? undefined,
    role: invite.role,
    expiresAt: normalizeDateValue(invite.expiresAt) ?? '',
    acceptedAt: normalizeDateValue(invite.acceptedAt),
    revokedAt: normalizeDateValue(invite.revokedAt),
    createdAt: normalizeDateValue(invite.createdAt) ?? '',
    ...(rawToken ? { token: rawToken } : {}),
  };
}

function sanitizeInviteLookup(invite: OrganizationInviteRecord): Record<string, unknown> {
  return {
    orgId: invite.orgId,
    role: invite.role,
    expiresAt: normalizeDateValue(invite.expiresAt) ?? '',
  };
}

function isInviteRuntimeAdapter(value: BareEntityAdapter): value is InviteRuntimeAdapter {
  return hasMethod(value, 'findPendingByToken') && hasMethod(value, 'reveal');
}

function requireInviteRuntimeAdapter(value: BareEntityAdapter): InviteRuntimeAdapter {
  if (!isInviteRuntimeAdapter(value)) {
    throw new Error('[slingshot-organizations] invite adapter runtime hooks are missing');
  }
  return value;
}

function getActorUserId(params: Record<string, unknown>): string {
  const userId = params['actor.id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  return userId;
}

function buildScopedMembershipId(scopeId: string, userId: string): string {
  return `${scopeId}:${userId}`;
}

async function findMembershipByUser(
  adapter: BareEntityAdapter,
  scopeField: 'orgId' | 'groupId',
  scopeId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const page = await adapter.list({
    filter: {
      [scopeField]: scopeId,
      userId,
    },
    limit: 1,
  });
  return ((page.items as Record<string, unknown>[])[0] ?? null) as Record<string, unknown> | null;
}

/**
 * Idempotent mark-as-accepted for an invite. Reveals the persisted record,
 * checks `acceptedAt`, and writes the timestamp only if it has not been set
 * already — so concurrent redemptions converge on the same final state and
 * never overwrite each other's value. Returns `true` when the invite is in a
 * terminal accepted state at the end of the call (already-accepted or just
 * marked); `false` when the update failed and the caller needs to surface a
 * partial-success signal.
 */
async function markInviteAcceptedIfNeeded(
  inviteRuntime: InviteRuntimeAdapter,
  inviteAdapter: BareEntityAdapter,
  inviteId: string,
  context: { orgId: string; userId: string },
): Promise<boolean> {
  const revealed = await inviteRuntime.reveal(inviteId);
  if (!revealed) return true;
  if (revealed.acceptedAt) return true;
  try {
    await inviteAdapter.update(revealed.id, {
      acceptedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logError(
      'organizations.invite.acceptedAt.update_failed',
      { inviteId: revealed.id, orgId: context.orgId, userId: context.userId },
      err,
    );
    return false;
  }
}

const LIST_MINE_DEFAULT_LIMIT = 50;
const LIST_MINE_MAX_LIMIT = 100;

function parsePositiveInt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  if (typeof input === 'string') {
    const n = Number.parseInt(input, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function parseCursor(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}

/**
 * Page through all records matching `filter` and call `adapter.delete()` for
 * each. Used by the org-delete cascade.
 */
async function deleteAllByFilter(
  adapter: BareEntityAdapter,
  filter: Record<string, unknown>,
): Promise<void> {
  const PAGE = 200;
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.list({ filter, limit: PAGE, ...(cursor ? { cursor } : {}) });
    const items = page.items as ReadonlyArray<{ id?: unknown }>;
    for (const item of items) {
      const recordId = typeof item?.id === 'string' ? item.id : undefined;
      if (!recordId) continue;
      await adapter.delete(recordId);
    }
    const nextCursor = page.nextCursor ?? page.cursor;
    if (!nextCursor || items.length < PAGE) {
      return;
    }
    cursor = nextCursor;
  }
}

/**
 * Page through all records matching `filter` and return their string IDs.
 */
async function collectIds(
  adapter: BareEntityAdapter,
  filter: Record<string, unknown>,
): Promise<string[]> {
  const PAGE = 200;
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.list({ filter, limit: PAGE, ...(cursor ? { cursor } : {}) });
    const items = page.items as ReadonlyArray<{ id?: unknown }>;
    for (const item of items) {
      if (typeof item?.id === 'string') ids.push(item.id);
    }
    const nextCursor = page.nextCursor ?? page.cursor;
    if (!nextCursor || items.length < PAGE) {
      return ids;
    }
    cursor = nextCursor;
  }
}

/**
 * Run the cascade-delete steps that follow `Organization.delete`. Returns
 * the list of dependent collections that failed; an empty list means the
 * cascade is fully clean.
 *
 * Used both by the deleteCascade transform (immediately after deleting the
 * org row) and by `reconcileOrphanedOrgRecords()` for post-hoc recovery on
 * non-atomic backends.
 */
async function runOrgCascade(refs: AdapterRefs, orgId: string): Promise<string[]> {
  const failed: string[] = [];

  const memberAdapter = refs.members;
  if (memberAdapter) {
    try {
      await deleteAllByFilter(memberAdapter, { orgId });
    } catch (err) {
      failed.push('memberships');
      logError('organizations.delete.cascade.memberships_failed', { orgId }, err);
    }
  }

  const inviteAdapter = refs.invites;
  if (inviteAdapter) {
    try {
      await deleteAllByFilter(inviteAdapter, { orgId });
    } catch (err) {
      failed.push('invites');
      logError('organizations.delete.cascade.invites_failed', { orgId }, err);
    }
  }

  const groupAdapter = refs.groups;
  const groupMembershipAdapter = refs.groupMemberships;
  if (groupAdapter) {
    let groupIds: string[] = [];
    try {
      groupIds = await collectIds(groupAdapter, { orgId });
    } catch (err) {
      failed.push('groups');
      logError('organizations.delete.cascade.group_lookup_failed', { orgId }, err);
    }

    let groupMembershipFailures = false;
    if (groupIds.length > 0 && groupMembershipAdapter) {
      for (const groupId of groupIds) {
        try {
          await deleteAllByFilter(groupMembershipAdapter, { groupId });
        } catch (err) {
          groupMembershipFailures = true;
          if (!failed.includes('groupMemberships')) {
            failed.push('groupMemberships');
          }
          logError(
            'organizations.delete.cascade.group_memberships_failed',
            { orgId, groupId },
            err,
          );
        }
      }
    }

    // Only delete the group rows when their memberships were fully cleaned —
    // otherwise we orphan the membership rows past the point where reconcile
    // can find them again (group lookup by orgId would return empty). The
    // operator must call reconcileOrphanedOrgRecords once the underlying
    // adapter is healthy; until then, leave the groups in place.
    if (!groupMembershipFailures) {
      try {
        await deleteAllByFilter(groupAdapter, { orgId });
      } catch (err) {
        if (!failed.includes('groups')) {
          failed.push('groups');
        }
        logError('organizations.delete.cascade.groups_failed', { orgId }, err);
      }
    }
  }

  return failed;
}

async function batchFetchOrganizations(
  adapter: BareEntityAdapter,
  ids: ReadonlyArray<string>,
): Promise<Array<OrganizationRecord | null>> {
  if (ids.length === 0) return [];
  if (hasMethod(adapter, 'listByIds')) {
    const batchAdapter = adapter as OrganizationsBatchFetchAdapter;
    const records = await batchAdapter.listByIds(ids);
    return [...records];
  }
  const settled = await Promise.allSettled(
    ids.map(id => adapter.getById(id) as Promise<OrganizationRecord | null>),
  );
  return settled.map(r => (r.status === 'fulfilled' ? r.value : null));
}

/**
 * Manifest runtime augmented with operator recovery hooks. The
 * `reconcileOrphanedOrgRecords` method is also re-published on app
 * pluginState through {@link OrganizationsReconcileService} so callers
 * outside this module can invoke it without holding a runtime reference.
 *
 * See {@link ReconcileOrphanedOrgRecordsResult}.
 */
export interface OrganizationsRuntime extends EntityManifestRuntime {
  reconcileOrphanedOrgRecords(orgId: string): Promise<ReconcileOrphanedOrgRecordsResult>;
}

/**
 * Build the organizations manifest runtime.
 */
export function createOrganizationsManifestRuntime(args: {
  authRuntime: OrganizationsAuthRuntime;
  invitationTtlSeconds: number;
  defaultMemberRole: MemberRole;
  /**
   * Allowed values for `OrganizationMember.role`, `OrganizationInvite.role`, and
   * `GroupMembership.role`. Roles outside this set are rejected at create time
   * with a 400 response. Defaults to `['owner', 'admin', 'member']`.
   */
  knownRoles?: ReadonlyArray<string>;
  /**
   * Zod schema used to validate org slugs at HTTP-create time.
   * The same schema is also used by the programmatic `OrganizationsOrgService`.
   */
  slugSchema?: z.ZodType<string>;
  /**
   * Optional idempotency store used to deduplicate invite creations. Callers
   * pass `idempotencyKey` on the invite-create payload; this adapter caches the
   * sanitized invite response so a retried request returns the same record
   * without creating a duplicate. The raw invite token is returned only on
   * the first successful create and is never cached in the idempotency store.
   *
   * Defaults to a process-local in-memory adapter. Provide a Redis-backed
   * implementation in multi-instance deployments where the same key may hit
   * different processes.
   */
  inviteIdempotencyAdapter?: OperationIdempotencyAdapter;
  /**
   * TTL in milliseconds for cached idempotent invite responses. Defaults to
   * 24 hours, matching the typical invite lifecycle window.
   */
  inviteIdempotencyTtlMs?: number;
  onAdaptersCaptured?: (adapters: Required<AdapterRefs>) => void;
}): OrganizationsRuntime {
  const {
    authRuntime,
    invitationTtlSeconds,
    defaultMemberRole,
    knownRoles,
    slugSchema,
    onAdaptersCaptured,
  } = args;
  const inviteIdempotencyAdapter =
    args.inviteIdempotencyAdapter ?? createMemoryOperationIdempotencyAdapter();
  const inviteIdempotencyTtlMs = args.inviteIdempotencyTtlMs ?? 24 * 60 * 60 * 1000;
  const knownRoleSet = new Set<string>(knownRoles ?? DEFAULT_KNOWN_MEMBER_ROLES);
  if (knownRoleSet.size === 0) {
    throw new Error('[slingshot-organizations] knownRoles must contain at least one role');
  }
  if (!knownRoleSet.has(defaultMemberRole)) {
    throw new Error(
      `[slingshot-organizations] defaultMemberRole '${defaultMemberRole}' is not in knownRoles [${[...knownRoleSet].join(', ')}]`,
    );
  }

  function resolveRole(input: unknown): string {
    const role = typeof input === 'string' && input.length > 0 ? input : defaultMemberRole;
    if (!knownRoleSet.has(role)) {
      throw new HTTPException(400, {
        message: `Invalid role '${role}'. Allowed: [${[...knownRoleSet].join(', ')}]`,
      });
    }
    return role;
  }

  const adapterTransforms = createEntityAdapterTransformRegistry();
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();
  const refs: AdapterRefs = {};

  // Convert duplicate-key violations on `Organization.create` into a typed
  // `SlugConflictError` (HTTP 409, code `SLUG_CONFLICT`). Authoritative
  // correctness comes from the unique index on `Organization.slug` — the
  // pre-flight availability check is a UX optimization. Under concurrent
  // requests, two callers can both observe "slug available" and only the
  // unique-constraint catch reliably converts the loser into a 409.
  adapterTransforms.register('organizations.organization.slugConflictCatch', adapter => {
    const orgAdapter = requireMethod(adapter, 'create');
    return {
      ...adapter,
      create: async (input: unknown) => {
        const record = (input ?? {}) as Record<string, unknown>;
        try {
          return await orgAdapter.create(record);
        } catch (err) {
          if (isUniqueViolationError(err)) {
            const slug = typeof record.slug === 'string' ? record.slug : '';
            throw new SlugConflictError(slug);
          }
          throw err;
        }
      },
    };
  });

  if (slugSchema) {
    adapterTransforms.register('organizations.organization.slugValidation', adapter => {
      const orgAdapter = requireMethod(adapter, 'create');
      return {
        ...adapter,
        create: async (input: unknown) => {
          const record = (input ?? {}) as Record<string, unknown>;
          if ('slug' in record) {
            const result = slugSchema.safeParse(record.slug);
            if (!result.success) {
              const message = result.error.issues[0]?.message ?? 'slug failed validation';
              throw new HTTPException(400, { message: `Invalid slug: ${message}` });
            }
            record.slug = result.data;
          }
          return orgAdapter.create(record);
        },
      };
    });
  }

  // Cascade-delete transform: when an organization is deleted, explicitly delete
  // all dependent records (memberships, invites, groups, and group memberships
  // for those groups) without relying on adapter-level FK cascades.
  //
  // Semantics:
  //   - Full success           → returns true (HTTP 204 from the entity layer)
  //   - Partial cascade failure → throws HTTP 500 with a structured body that
  //     names which dependent collections were left orphaned. Operators recover
  //     by calling `reconcileOrphanedOrgRecords(orgId)` (exposed on the runtime
  //     object returned by `createOrganizationsManifestRuntime`).
  //   - The org row itself is deleted before the cascade runs, so a 500 here
  //     means "org gone, dependents leaked" — exactly what the reconciliation
  //     API is designed to mop up.
  //
  // Adapter atomicity: SQL-backed adapters (Postgres, SQLite) typically run
  // the cascade inside an implicit transaction managed by the entity layer
  // and roll back on error. Memory and Mongo adapters cannot guarantee
  // atomicity across multiple deletes, so the reconciliation API is the
  // authoritative recovery path for those backends.
  adapterTransforms.register('organizations.organization.deleteCascade', adapter => {
    const orgAdapter = requireMethod(adapter, 'delete');
    return {
      ...adapter,
      delete: async (id: string, filter?: Record<string, unknown>) => {
        const ok = await orgAdapter.delete(id, filter);
        if (!ok) {
          return false;
        }
        const failed = await runOrgCascade(refs, id);
        if (failed.length > 0) {
          // Structured "deleteFailed" event log so operators can detect the
          // orphan condition without parsing the HTTP response.
          logError(
            'organizations.org.deleteFailed',
            { orgId: id, failed, reconcileWith: 'reconcileOrphanedOrgRecords' },
            new Error(`partial cascade: failed=[${failed.join(',')}]`),
          );
          const body = JSON.stringify({
            error: 'org_delete_partial',
            id,
            failed,
            reconcile:
              'Call reconcileOrphanedOrgRecords(orgId) on the organizations runtime to remove orphans',
          });
          throw new HTTPException(500, {
            res: new Response(body, {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
          });
        }
        return true;
      },
    };
  });

  adapterTransforms.register('organizations.member.identity', adapter => {
    const memberAdapter = requireMethod(adapter, 'create');
    return {
      ...adapter,
      create: async (input: unknown) => {
        const record = input as Record<string, unknown>;
        const nextInput = {
          ...record,
          id: buildScopedMembershipId(record.orgId as string, record.userId as string),
          role: resolveRole(record.role),
        };
        return memberAdapter.create(nextInput);
      },
    };
  });

  adapterTransforms.register('organizations.groupMembership.identity', adapter => {
    const membershipAdapter = requireMethod(adapter, 'create');
    return {
      ...adapter,
      create: async (input: unknown) => {
        const record = input as Record<string, unknown>;
        return membershipAdapter.create({
          ...record,
          id: buildScopedMembershipId(record.groupId as string, record.userId as string),
          role: resolveRole(record.role),
        });
      },
    };
  });

  adapterTransforms.register('organizations.invite.runtime', adapter => {
    const inviteAdapter = requireMethod(adapter, 'create');
    return {
      ...adapter,
      create: async (input: unknown) => {
        const record = { ...(input as Record<string, unknown>) };
        // Pull idempotencyKey out of the payload — it's a transport-level
        // dedupe hint and must never reach the entity row. The raw invite token
        // is deliberately excluded from the idempotency cache.
        const idempotencyKeyRaw = record.idempotencyKey;
        delete record.idempotencyKey;
        const idempotencyKey =
          typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.length > 0
            ? idempotencyKeyRaw
            : null;

        const doCreate = async (): Promise<Record<string, unknown>> => {
          const rawToken = randomBytes(32).toString('base64url');
          const persisted = (await inviteAdapter.create({
            ...record,
            tokenHash: sha256(rawToken),
            role: resolveRole(record.role),
            expiresAt:
              typeof record.expiresAt === 'string' && record.expiresAt.length > 0
                ? record.expiresAt
                : new Date(Date.now() + invitationTtlSeconds * 1000).toISOString(),
          })) as OrganizationInviteRecord;
          return sanitizeInvite(persisted, rawToken);
        };

        if (idempotencyKey !== null) {
          const orgId = typeof record.orgId === 'string' ? record.orgId : 'unknown';
          const key = makeIdempotencyKey(['organizations.invite', orgId, idempotencyKey]);
          const prior = await inviteIdempotencyAdapter.get(key);
          if (prior?.payload) return prior.payload as Record<string, unknown>;
          const result = await doCreate();
          const { token: _token, ...cached } = result;
          await inviteIdempotencyAdapter.set(key, cached, inviteIdempotencyTtlMs);
          return result;
        }
        return doCreate();
      },
      getById: async (id: string, filter?: Record<string, unknown>) => {
        const invite = (await adapter.getById(id, filter)) as OrganizationInviteRecord | null;
        return invite ? sanitizeInvite(invite) : null;
      },
      list: async (opts: { filter?: unknown; limit?: number; cursor?: string }) => {
        const page = await adapter.list(opts);
        return {
          ...page,
          items: (page.items as OrganizationInviteRecord[]).map(invite => sanitizeInvite(invite)),
        };
      },
      async findPendingByToken(rawToken: string) {
        const page = await adapter.list({
          filter: {
            tokenHash: sha256(rawToken),
          },
          limit: 1,
        });
        const invite = (page.items[0] as OrganizationInviteRecord | undefined) ?? null;
        if (!invite) return null;
        if (invite.acceptedAt || invite.revokedAt) return null;
        if (new Date(invite.expiresAt).getTime() < Date.now()) return null;
        return invite;
      },
      async reveal(id: string) {
        return (await adapter.getById(id)) as OrganizationInviteRecord | null;
      },
    };
  });

  hooks.register('organizations.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    refs.organizations = ctx.adapters.Organization;
    refs.members = ctx.adapters.OrganizationMember;
    refs.invites = ctx.adapters.OrganizationInvite;
    refs.groups = ctx.adapters.Group;
    refs.groupMemberships = ctx.adapters.GroupMembership;
    if (onAdaptersCaptured) {
      onAdaptersCaptured({
        organizations: refs.organizations,
        members: refs.members,
        invites: refs.invites,
        groups: refs.groups,
        groupMemberships: refs.groupMemberships,
      });
    }
  });

  customHandlers.register(
    'organizations.organization.listMine',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const userId = getActorUserId(params);
      const memberAdapter = refs.members;
      const organizationAdapter = refs.organizations;
      if (!memberAdapter || !organizationAdapter) {
        throw new Error(
          '[slingshot-organizations] listMine executed before adapters were captured',
        );
      }
      const requestedLimit = parsePositiveInt(params.limit) ?? LIST_MINE_DEFAULT_LIMIT;
      const limit = Math.min(LIST_MINE_MAX_LIMIT, Math.max(1, requestedLimit));
      const cursor = parseCursor(params.cursor);
      const membershipsPage = await memberAdapter.list({
        filter: { userId },
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const memberships = membershipsPage.items as OrganizationMemberRecord[];
      const orgIds = memberships.map(m => m.orgId);
      const records = await batchFetchOrganizations(organizationAdapter, orgIds);
      const items = records.filter((r): r is OrganizationRecord => r !== null);
      const nextCursor = membershipsPage.nextCursor ?? membershipsPage.cursor ?? undefined;
      const hasMore = membershipsPage.hasMore ?? Boolean(nextCursor);
      return {
        items,
        nextCursor: nextCursor ?? null,
        hasMore,
      };
    },
  );

  customHandlers.register(
    'organizations.invite.findByToken',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const token = typeof params.token === 'string' ? params.token : '';
      const inviteAdapter = refs.invites;
      if (!inviteAdapter) {
        throw new Error(
          '[slingshot-organizations] findByToken executed before adapters were captured',
        );
      }
      if (!token) {
        throw new HTTPException(400, { message: 'token is required' });
      }
      const invite = await requireInviteRuntimeAdapter(inviteAdapter).findPendingByToken(token);
      return invite ? sanitizeInviteLookup(invite) : null;
    },
  );

  customHandlers.register('organizations.invite.redeem', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const token = typeof params.token === 'string' ? params.token : '';
    const actorUserId = getActorUserId(params);
    const inviteAdapter = refs.invites;
    const memberAdapter = refs.members;
    const organizationAdapter = refs.organizations;
    if (!inviteAdapter || !memberAdapter || !organizationAdapter) {
      throw new Error('[slingshot-organizations] redeem executed before adapters were captured');
    }
    if (!token) {
      throw new HTTPException(400, { message: 'token is required' });
    }

    const inviteRuntime = requireInviteRuntimeAdapter(inviteAdapter);
    const invite = await inviteRuntime.findPendingByToken(token);
    if (!invite) {
      throw new HTTPException(404, { message: 'Invite not found' });
    }

    if (invite.userId && invite.userId !== actorUserId) {
      throw new HTTPException(403, { message: 'This invitation belongs to a different user' });
    }
    // Suspended-account guard. Performed before any membership work so a
    // suspended user can never be added to an org through invite redemption,
    // even if an invite was already issued. Mirrors the regression P-ORG-4 and
    // is enforced regardless of whether the invite was email-targeted or not.
    if (authRuntime.adapter.getUser) {
      const authUser = await authRuntime.adapter.getUser(actorUserId);
      if (authUser?.suspended === true) {
        throw new HTTPException(403, { message: 'account_suspended' });
      }
    }
    if (invite.email) {
      if (!authRuntime.adapter.getUser || !authRuntime.adapter.getEmailVerified) {
        throw new HTTPException(403, {
          message: 'This invitation requires an account with a verified matching email address',
        });
      }
      const authUser = await authRuntime.adapter.getUser(actorUserId);
      const verified = await authRuntime.adapter.getEmailVerified(actorUserId);
      const inviteEmail = invite.email.trim().toLowerCase();
      const currentEmail = authUser?.email?.trim().toLowerCase();
      if (!verified || !currentEmail || inviteEmail !== currentEmail) {
        throw new HTTPException(403, {
          message: 'This invitation requires an account with a verified matching email address',
        });
      }
    }

    const existing = (await findMembershipByUser(
      memberAdapter,
      'orgId',
      invite.orgId,
      actorUserId,
    )) as OrganizationMemberRecord | null;
    if (existing) {
      const organization = (await organizationAdapter.getById(
        invite.orgId,
      )) as OrganizationRecord | null;
      // Even on the already-member path, mark the invite accepted exactly once
      // so the invite reaches a final state instead of remaining "pending"
      // forever after a benign concurrent-redeem.
      await markInviteAcceptedIfNeeded(inviteRuntime, inviteAdapter, invite.id, {
        orgId: invite.orgId,
        userId: actorUserId,
      });
      return { organization, membership: existing, alreadyMember: true };
    }

    // Race-safe membership creation. Two concurrent redemptions can both pass
    // the `existing` lookup above and reach `create()`. Without this guard,
    // the second create rejects with a unique-constraint violation on the
    // composite `(orgId, userId)` membership id and the caller sees a 500
    // even though the membership was successfully created by the first call.
    let membership: OrganizationMemberRecord;
    let alreadyMember = false;
    try {
      membership = (await memberAdapter.create({
        orgId: invite.orgId,
        userId: actorUserId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      })) as OrganizationMemberRecord;
    } catch (err) {
      if (!isUniqueViolationError(err)) {
        throw err;
      }
      // Look up the membership the winning request created and proceed with
      // it as if we had observed it on the initial `existing` check.
      const winning = (await findMembershipByUser(
        memberAdapter,
        'orgId',
        invite.orgId,
        actorUserId,
      )) as OrganizationMemberRecord | null;
      if (!winning) {
        // Unique-constraint failure but we still cannot find the membership —
        // surface the original error rather than masking a real bug.
        throw err;
      }
      membership = winning;
      alreadyMember = true;
      logError(
        'organizations.invite.redeem.member_create.unique_violation_recovered',
        { orgId: invite.orgId, userId: actorUserId },
        err,
      );
    }
    const acceptedAtMarked = await markInviteAcceptedIfNeeded(
      inviteRuntime,
      inviteAdapter,
      invite.id,
      { orgId: invite.orgId, userId: actorUserId },
    );
    const organization = (await organizationAdapter.getById(
      invite.orgId,
    )) as OrganizationRecord | null;
    return {
      organization,
      membership,
      alreadyMember,
      ...(acceptedAtMarked ? {} : { partial: true as const }),
    };
  });

  customHandlers.register('organizations.invite.revoke', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const id = typeof params.id === 'string' ? params.id : '';
    const inviteAdapter = refs.invites;
    if (!inviteAdapter) {
      throw new Error('[slingshot-organizations] revoke executed before adapters were captured');
    }
    if (!id) {
      throw new HTTPException(400, { message: 'id is required' });
    }
    const updated = await inviteAdapter.update(id, {
      revokedAt: new Date().toISOString(),
    });
    if (!updated) {
      throw new HTTPException(404, { message: 'Invite not found' });
    }
    return sanitizeInvite(updated as OrganizationInviteRecord);
  });

  async function reconcileOrphanedOrgRecords(
    orgId: string,
  ): Promise<ReconcileOrphanedOrgRecordsResult> {
    if (typeof orgId !== 'string' || orgId.length === 0) {
      throw new Error(
        '[slingshot-organizations] reconcileOrphanedOrgRecords requires a non-empty orgId',
      );
    }
    const organizationAdapter = refs.organizations;
    const orgGone = organizationAdapter
      ? (await organizationAdapter.getById(orgId)) === null
      : true;
    if (!orgGone) {
      throw new Error(
        `[slingshot-organizations] reconcileOrphanedOrgRecords refuses to run while org '${orgId}' still exists. ` +
          `Delete the org first (cascade will run); if cascade reports a partial failure, then call this to clean orphans.`,
      );
    }
    const failed = await runOrgCascade(refs, orgId);
    return Object.freeze({ orgId, orgGone: true, failed: Object.freeze([...failed]) });
  }

  return {
    adapterTransforms,
    customHandlers,
    hooks,
    reconcileOrphanedOrgRecords,
  };
}
