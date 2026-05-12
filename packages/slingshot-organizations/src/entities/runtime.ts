/**
 * Pure runtime helpers used by the organizations entity modules.
 *
 * Adapter transforms wrap each entity adapter to enforce slug validation,
 * cascade-delete, scoped membership ids, and the invite-token lifecycle.
 * Custom-op handlers implement the four bespoke routes (`listMine`,
 * `findByToken`, `redeem`, `revokeInvite`) that the entity-shell does not
 * generate for free.
 *
 * This module is consumed by `./modules.ts`. Every function here returns
 * either a plain adapter transform `(adapter) => adapter` or a plain async
 * handler `(input) => result`.
 */
import { createHash, randomBytes } from 'crypto';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type { OperationIdempotencyAdapter } from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  createMemoryOperationIdempotencyAdapter,
  makeIdempotencyKey,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { SlugConflictError, isUniqueViolationError } from '../errors';
import type { OrganizationsAuthRuntime } from '../lib/authRuntime';
import type { ReconcileOrphanedOrgRecordsResult } from '../reconcile';

/**
 * Structured-log helper for the package. Writes a single JSON line tagged
 * with the package prefix so log aggregators can group all
 * `slingshot-organizations` events.
 */
const runtimeLogger = createConsoleLogger({ base: { component: 'slingshot-organizations' } });

function logError(event: string, context: Record<string, unknown>, error: unknown): void {
  runtimeLogger.error(event, {
    ...context,
    err: error instanceof Error ? error.message : String(error),
  });
}

type MemberRole = string;

export const DEFAULT_KNOWN_MEMBER_ROLES: ReadonlyArray<string> = ['owner', 'admin', 'member'];

export type OrganizationRecord = {
  id: string;
  tenantId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  logoUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  invitedBy?: string | null;
};

export type OrganizationInviteRecord = {
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

/**
 * Mutable bag of resolved entity adapters owned by the package factory.
 *
 * The `manual`-wiring `buildAdapter` callbacks populate this bag at adapter
 * resolution time, before any route handler runs. Custom-op handlers and the
 * cascade-delete transform read through the same bag so every surface sees
 * the same adapter instance (critical for memory-store correctness).
 */
export type OrganizationsAdapterRefs = {
  organizations?: BareEntityAdapter;
  members?: BareEntityAdapter;
  invites?: BareEntityAdapter;
  groups?: BareEntityAdapter;
  groupMemberships?: BareEntityAdapter;
};

export type InviteRuntimeAdapter = BareEntityAdapter & {
  findPendingByToken(rawToken: string): Promise<OrganizationInviteRecord | null>;
  reveal(id: string): Promise<OrganizationInviteRecord | null>;
};

type OrganizationsBatchFetchAdapter = BareEntityAdapter & {
  listByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<OrganizationRecord | null>>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeDateValue(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
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
 * Idempotent mark-as-accepted for an invite. See manifest/runtime.ts (lifted
 * verbatim — same semantics).
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
    if (!nextCursor || items.length < PAGE) return;
    cursor = nextCursor;
  }
}

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
    if (!nextCursor || items.length < PAGE) return ids;
    cursor = nextCursor;
  }
}

/**
 * Run the dependent-row cascade for an organization. Returns the list of
 * dependent collections that failed; an empty list means a clean cascade.
 *
 * Used by the deleteCascade transform (after the org row is deleted) and by
 * `reconcileOrphanedOrgRecords()` for post-hoc recovery on non-atomic
 * backends.
 */
export async function runOrgCascade(
  refs: OrganizationsAdapterRefs,
  orgId: string,
): Promise<string[]> {
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

// ─── Adapter transforms ───────────────────────────────────────────────────────

/**
 * Convert duplicate-key violations on `Organization.create` into the typed
 * `SlugConflictError` (HTTP 409, code `SLUG_CONFLICT`).
 */
export function applySlugConflictCatchTransform(adapter: BareEntityAdapter): BareEntityAdapter {
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
}

/**
 * Validate the `slug` field on `Organization.create` against the configured
 * Zod schema, returning HTTP 400 with a structured message on failure.
 */
export function applySlugValidationTransform(
  adapter: BareEntityAdapter,
  slugSchema: z.ZodType<string>,
): BareEntityAdapter {
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
}

/**
 * Cascade-delete transform wired to a shared {@link OrganizationsAdapterRefs}
 * bag. When `Organization.delete` succeeds the transform runs
 * `runOrgCascade(refs, id)` on the same adapters; on partial failure it
 * throws HTTP 500 with a structured body operators can match on.
 */
export function applyDeleteCascadeTransform(
  adapter: BareEntityAdapter,
  refs: OrganizationsAdapterRefs,
): BareEntityAdapter {
  const orgAdapter = requireMethod(adapter, 'delete');
  return {
    ...adapter,
    delete: async (id: string, filter?: Record<string, unknown>) => {
      const ok = await orgAdapter.delete(id, filter);
      if (!ok) return false;
      const failed = await runOrgCascade(refs, id);
      if (failed.length > 0) {
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
}

/**
 * Membership identity transform — assigns a composite `orgId:userId` id and
 * validates the role against the configured known-role set.
 */
export function applyMemberIdentityTransform(
  adapter: BareEntityAdapter,
  args: { resolveRole: (input: unknown) => string },
): BareEntityAdapter {
  const memberAdapter = requireMethod(adapter, 'create');
  return {
    ...adapter,
    create: async (input: unknown) => {
      const record = input as Record<string, unknown>;
      return memberAdapter.create({
        ...record,
        id: buildScopedMembershipId(record.orgId as string, record.userId as string),
        role: args.resolveRole(record.role),
      });
    },
  };
}

/**
 * Group-membership identity transform — composite `groupId:userId` id +
 * role validation.
 */
export function applyGroupMembershipIdentityTransform(
  adapter: BareEntityAdapter,
  args: { resolveRole: (input: unknown) => string },
): BareEntityAdapter {
  const membershipAdapter = requireMethod(adapter, 'create');
  return {
    ...adapter,
    create: async (input: unknown) => {
      const record = input as Record<string, unknown>;
      return membershipAdapter.create({
        ...record,
        id: buildScopedMembershipId(record.groupId as string, record.userId as string),
        role: args.resolveRole(record.role),
      });
    },
  };
}

/**
 * Invite runtime transform — handles token hashing, idempotency caching,
 * sanitized read paths, and the `findPendingByToken` / `reveal` helper
 * methods custom-op handlers depend on.
 */
export function applyInviteRuntimeTransform(
  adapter: BareEntityAdapter,
  args: {
    invitationTtlSeconds: number;
    resolveRole: (input: unknown) => string;
    inviteIdempotencyAdapter: OperationIdempotencyAdapter;
    inviteIdempotencyTtlMs: number;
  },
): BareEntityAdapter {
  const {
    invitationTtlSeconds,
    resolveRole,
    inviteIdempotencyAdapter,
    inviteIdempotencyTtlMs,
  } = args;
  const inviteAdapter = requireMethod(adapter, 'create');
  const wrapped: InviteRuntimeAdapter = {
    ...adapter,
    create: async (input: unknown) => {
      const record = { ...(input as Record<string, unknown>) };
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
        const cached = { ...result };
        delete cached.token;
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
        filter: { tokenHash: sha256(rawToken) },
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
  return wrapped;
}

// ─── Custom-op handlers ───────────────────────────────────────────────────────

/**
 * `GET /orgs/mine` — list the organizations the calling user is a member of.
 * Bypasses the standard list authorization (admin-only) so members can read
 * their own org memberships.
 */
export function createListMineHandler(refs: OrganizationsAdapterRefs) {
  return async (input: unknown) => {
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
  };
}

/**
 * `POST /orgs/:orgId/invitations/lookup` — look up a pending invite by token.
 */
export function createFindByTokenHandler(refs: OrganizationsAdapterRefs) {
  return async (input: unknown) => {
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
  };
}

/**
 * `POST /orgs/:orgId/invitations/redeem` — redeem a pending invite. Honours
 * email targeting, suspended-account guard, and the alreadyMember /
 * acceptedAt-marked / partial-success branches.
 */
export function createRedeemHandler(args: {
  refs: OrganizationsAdapterRefs;
  authRuntime: OrganizationsAuthRuntime;
}) {
  const { refs, authRuntime } = args;
  return async (input: unknown) => {
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
      await markInviteAcceptedIfNeeded(inviteRuntime, inviteAdapter, invite.id, {
        orgId: invite.orgId,
        userId: actorUserId,
      });
      return { organization, membership: existing, alreadyMember: true };
    }

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
      const winning = (await findMembershipByUser(
        memberAdapter,
        'orgId',
        invite.orgId,
        actorUserId,
      )) as OrganizationMemberRecord | null;
      if (!winning) throw err;
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
  };
}

/**
 * `DELETE /orgs/:orgId/invitations/:id` — mark an invite revoked. The
 * generated DELETE route is disabled on OrganizationInvite specifically so
 * this handler controls the response shape.
 */
export function createRevokeHandler(refs: OrganizationsAdapterRefs) {
  return async (input: unknown) => {
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
  };
}

/**
 * Post-hoc recovery API for an org whose cascade-delete left orphaned
 * dependent rows. Refuses to run while the org row still exists.
 */
export async function reconcileOrphanedOrgRecords(
  refs: OrganizationsAdapterRefs,
  orgId: string,
): Promise<ReconcileOrphanedOrgRecordsResult> {
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error(
      '[slingshot-organizations] reconcileOrphanedOrgRecords requires a non-empty orgId',
    );
  }
  const organizationAdapter = refs.organizations;
  const orgGone = organizationAdapter ? (await organizationAdapter.getById(orgId)) === null : true;
  if (!orgGone) {
    throw new Error(
      `[slingshot-organizations] reconcileOrphanedOrgRecords refuses to run while org '${orgId}' still exists. ` +
        `Delete the org first (cascade will run); if cascade reports a partial failure, then call this to clean orphans.`,
    );
  }
  const failed = await runOrgCascade(refs, orgId);
  return Object.freeze({ orgId, orgGone: true, failed: Object.freeze([...failed]) });
}

/**
 * Build the shared role-resolver function used by member, invite, and
 * group-membership transforms. Throws HTTP 400 if a role outside the known
 * set is requested.
 */
export function createRoleResolver(args: {
  knownRoles: ReadonlyArray<string>;
  defaultMemberRole: MemberRole;
}): (input: unknown) => string {
  const knownRoleSet = new Set<string>(args.knownRoles);
  if (knownRoleSet.size === 0) {
    throw new Error('[slingshot-organizations] knownRoles must contain at least one role');
  }
  if (!knownRoleSet.has(args.defaultMemberRole)) {
    throw new Error(
      `[slingshot-organizations] defaultMemberRole '${args.defaultMemberRole}' is not in knownRoles [${[...knownRoleSet].join(', ')}]`,
    );
  }
  return (input: unknown) => {
    const role =
      typeof input === 'string' && input.length > 0 ? input : args.defaultMemberRole;
    if (!knownRoleSet.has(role)) {
      throw new HTTPException(400, {
        message: `Invalid role '${role}'. Allowed: [${[...knownRoleSet].join(', ')}]`,
      });
    }
    return role;
  };
}

export function createInviteIdempotencyDefaults(
  custom?: OperationIdempotencyAdapter,
): { adapter: OperationIdempotencyAdapter; ttlMs: number } {
  return {
    adapter: custom ?? createMemoryOperationIdempotencyAdapter(),
    ttlMs: 24 * 60 * 60 * 1000,
  };
}
