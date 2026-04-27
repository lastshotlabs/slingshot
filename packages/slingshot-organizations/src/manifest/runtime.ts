import { createHash, randomUUID } from 'crypto';
import { HTTPException } from 'hono/http-exception';
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
import type { OrganizationsAuthRuntime } from '../lib/authRuntime';

type MemberRole = 'owner' | 'admin' | 'member';

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
 * Build the organizations manifest runtime.
 */
export function createOrganizationsManifestRuntime(args: {
  authRuntime: OrganizationsAuthRuntime;
  invitationTtlSeconds: number;
  defaultMemberRole: MemberRole;
  onAdaptersCaptured?: (adapters: Required<AdapterRefs>) => void;
}): EntityManifestRuntime {
  const { authRuntime, invitationTtlSeconds, defaultMemberRole, onAdaptersCaptured } = args;
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();
  const refs: AdapterRefs = {};

  adapterTransforms.register('organizations.member.identity', adapter => {
    const memberAdapter = requireMethod(adapter, 'create');
    return {
      ...adapter,
      create: async (input: unknown) => {
        const record = input as Record<string, unknown>;
        const nextInput = {
          ...record,
          id: buildScopedMembershipId(record.orgId as string, record.userId as string),
          role:
            typeof record.role === 'string' && record.role.length > 0
              ? record.role
              : defaultMemberRole,
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
          role:
            typeof record.role === 'string' && record.role.length > 0
              ? record.role
              : defaultMemberRole,
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
          role:
            typeof record.role === 'string' && record.role.length > 0
              ? record.role
              : defaultMemberRole,
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
      const membershipsPage = await memberAdapter.list({
        filter: { userId },
        limit: 500,
      });
      const memberships = membershipsPage.items as OrganizationMemberRecord[];
      const orgResults = await Promise.allSettled(
        memberships.map(async membership => {
          return (await organizationAdapter.getById(membership.orgId)) as OrganizationRecord | null;
        }),
      );
      return orgResults
        .filter(
          (r): r is PromiseFulfilledResult<OrganizationRecord> =>
            r.status === 'fulfilled' && r.value !== null,
        )
        .map(r => r.value);
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
    if (revealed) {
      try {
        await inviteAdapter.update(revealed.id, {
          acceptedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[slingshot-organizations] Failed to mark invite as accepted:', err);
      }
    }
    const organization = (await organizationAdapter.getById(
      invite.orgId,
    )) as OrganizationRecord | null;
    return { organization, membership, alreadyMember: false };
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
