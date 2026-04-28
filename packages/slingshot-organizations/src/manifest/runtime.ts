import { createHash, randomUUID } from 'crypto';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
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
  onAdaptersCaptured?: (adapters: Required<AdapterRefs>) => void;
}): EntityManifestRuntime {
  const {
    authRuntime,
    invitationTtlSeconds,
    defaultMemberRole,
    knownRoles,
    slugSchema,
    onAdaptersCaptured,
  } = args;
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
  // for those groups) without relying on adapter-level FK cascades. Partial
  // failures surface metadata to the caller via a 207-style HTTPException so
  // operators can detect mid-flight failures and reconcile.
  adapterTransforms.register('organizations.organization.deleteCascade', adapter => {
    const orgAdapter = requireMethod(adapter, 'delete');
    return {
      ...adapter,
      delete: async (id: string, filter?: Record<string, unknown>) => {
        const ok = await orgAdapter.delete(id, filter);
        if (!ok) {
          return false;
        }
        const failed: string[] = [];

        const memberAdapter = refs.members;
        if (memberAdapter) {
          try {
            await deleteAllByFilter(memberAdapter, { orgId: id });
          } catch (err) {
            failed.push('memberships');
            logError('organizations.delete.cascade.memberships_failed', { orgId: id }, err);
          }
        }

        const inviteAdapter = refs.invites;
        if (inviteAdapter) {
          try {
            await deleteAllByFilter(inviteAdapter, { orgId: id });
          } catch (err) {
            failed.push('invites');
            logError('organizations.delete.cascade.invites_failed', { orgId: id }, err);
          }
        }

        const groupAdapter = refs.groups;
        const groupMembershipAdapter = refs.groupMemberships;
        if (groupAdapter) {
          let groupIds: string[] = [];
          try {
            groupIds = await collectIds(groupAdapter, { orgId: id });
          } catch (err) {
            failed.push('groups');
            logError('organizations.delete.cascade.group_lookup_failed', { orgId: id }, err);
          }

          if (groupIds.length > 0 && groupMembershipAdapter) {
            for (const groupId of groupIds) {
              try {
                await deleteAllByFilter(groupMembershipAdapter, { groupId });
              } catch (err) {
                if (!failed.includes('groupMemberships')) {
                  failed.push('groupMemberships');
                }
                logError(
                  'organizations.delete.cascade.group_memberships_failed',
                  { orgId: id, groupId },
                  err,
                );
              }
            }
          }

          try {
            await deleteAllByFilter(groupAdapter, { orgId: id });
          } catch (err) {
            if (!failed.includes('groups')) {
              failed.push('groups');
            }
            logError('organizations.delete.cascade.groups_failed', { orgId: id }, err);
          }
        }

        if (failed.length > 0) {
          const body = JSON.stringify({
            id,
            partial: true,
            failed,
          });
          throw new HTTPException(207, {
            res: new Response(body, {
              status: 207,
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
        const record = input as Record<string, unknown>;
        const rawToken = randomUUID();
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
      return { organization, membership: existing, alreadyMember: true };
    }

    const membership = (await memberAdapter.create({
      orgId: invite.orgId,
      userId: actorUserId,
      role: invite.role,
      invitedBy: invite.invitedBy,
    })) as OrganizationMemberRecord;
    const revealed = await inviteRuntime.reveal(invite.id);
    let acceptedAtMarked = true;
    if (revealed) {
      try {
        await inviteAdapter.update(revealed.id, {
          acceptedAt: new Date().toISOString(),
        });
      } catch (err) {
        // The membership write succeeded — surface the failure so callers know
        // the invite remains in a non-final state and structured-log the error
        // for an admin reconciliation job.
        acceptedAtMarked = false;
        logError(
          'organizations.invite.acceptedAt.update_failed',
          { inviteId: revealed.id, orgId: invite.orgId, userId: actorUserId },
          err,
        );
      }
    }
    const organization = (await organizationAdapter.getById(
      invite.orgId,
    )) as OrganizationRecord | null;
    return {
      organization,
      membership,
      alreadyMember: false,
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

  return {
    adapterTransforms,
    customHandlers,
    hooks,
  };
}
