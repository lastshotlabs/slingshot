/**
 * Pure runtime helpers used by the community entity modules and the package
 * factory.
 *
 * Houses the adapter ref bag plus the lifted custom-op handlers
 * (`redeemInvite`, `claimInviteSlot`, `releaseInviteSlot`) that the entity
 * shell does not generate for free. The middleware factories that consume
 * adapter refs (banCheck, autoMod, threadStateGuard, …) are wired separately
 * by the package factory.
 *
 * No `EntityManifestRuntime` involved — every export here is either a plain
 * adapter ref shape, a plain async handler, or a small typed builder.
 */
import { HTTPException } from 'hono/http-exception';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';

// ---------------------------------------------------------------------------
// Adapter shapes
// ---------------------------------------------------------------------------

export type ContainerAdapter = {
  getById(id: string): Promise<{ id: string; joinPolicy?: string; deletedAt?: unknown } | null>;
};

export type ThreadAdapter = {
  getById(id: string): Promise<{
    createdAt?: string | Date;
    containerId: string;
    status?: string;
  } | null>;
  incrementReplyCount(id: string): Promise<unknown>;
  decrementReplyCount(id: string): Promise<unknown>;
  updateLastActivity(
    match: { id: string },
    data: { lastActivityAt?: string; lastReplyById?: string; lastReplyAt?: string },
  ): Promise<unknown>;
  update(id: string, data: unknown): Promise<unknown>;
  updateComponents(match: { id: string }, data: { components?: unknown }): Promise<unknown>;
};

export type ReplyAdapter = {
  getById(id: string): Promise<{
    createdAt?: string | Date;
    threadId?: string;
    containerId: string;
    status?: string;
  } | null>;
  update(id: string, data: unknown): Promise<unknown>;
  updateComponents(match: { id: string }, data: { components?: unknown }): Promise<unknown>;
};

export type ReactionAdapter = {
  listByTarget(params: { targetId: string; targetType: string }): Promise<{
    items: Array<{ type: string; value?: string | null }>;
  }>;
};

export type ContainerMemberAdapter = {
  create(input: { containerId: string; userId: string; role?: string }): Promise<unknown>;
  getMember(params: { containerId: string; userId: string }): Promise<unknown>;
  getById(id: string): Promise<{ role?: string; userId?: string; containerId?: string } | null>;
};

export type ReportAdapter = {
  create(input: Record<string, unknown>): Promise<unknown>;
};

export type BanAdapter = {
  list(input: { filter: Record<string, unknown>; limit?: number }): Promise<{ items: unknown[] }>;
};

export type AuditLogAdapter = {
  create(input: Record<string, unknown>): Promise<unknown>;
};

export type AutoModRuleAdapter = {
  list(input: { filter?: Record<string, unknown>; limit?: number }): Promise<{
    items: Array<{
      tenantId?: string | null;
      containerId?: string | null;
      enabled?: boolean;
      matcher?: unknown;
      decision?: 'flag' | 'reject' | 'shadow-ban';
      priority?: number;
      name?: string;
    }>;
  }>;
};

export type InviteRecord = {
  id: string;
  containerId: string;
  createdBy: string;
  maxUses?: number | null;
  usesRemaining?: number | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
};

export type ContainerInviteAdapter = {
  getById(id: string): Promise<InviteRecord | null>;
  findByToken(params: { token: string }): Promise<InviteRecord | null>;
  update(id: string, input: Record<string, unknown>): Promise<InviteRecord | null>;
};

/**
 * Shared adapter ref bag populated by entity modules' `wiring.buildAdapter`
 * callbacks during bootstrap. Custom-op handlers and adapter-dependent
 * middleware read through these refs at request time so each package instance
 * keeps its own adapters (Rule 3 — closure-owned state, no globals).
 */
export interface CommunityAdapterRefs {
  container?: ContainerAdapter;
  thread?: ThreadAdapter;
  reply?: ReplyAdapter;
  reaction?: ReactionAdapter;
  member?: ContainerMemberAdapter;
  report?: ReportAdapter;
  ban?: BanAdapter;
  auditLog?: AuditLogAdapter;
  autoModRule?: AutoModRuleAdapter;
  invite?: ContainerInviteAdapter;
}

// ---------------------------------------------------------------------------
// Invite slot helpers (formerly manifest custom handlers)
// ---------------------------------------------------------------------------

function getUserId(params: Record<string, unknown>): string {
  const userId = params['actor.id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  return userId;
}

async function claimInviteSlot(
  inviteAdapter: ContainerInviteAdapter | undefined,
  inviteId: string | undefined,
): Promise<InviteRecord | null> {
  if (!inviteId || !inviteAdapter) {
    return null;
  }
  const invite = await inviteAdapter.getById(inviteId);
  if (!invite) return null;
  if (invite.revokedAt) return null;
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) return null;
  if (invite.maxUses != null && (invite.usesRemaining ?? 0) <= 0) return null;
  if (invite.maxUses == null) return invite;
  return inviteAdapter.update(invite.id, {
    usesRemaining: (invite.usesRemaining ?? invite.maxUses) - 1,
  });
}

async function releaseInviteSlot(
  inviteAdapter: ContainerInviteAdapter | undefined,
  inviteId: string | undefined,
): Promise<InviteRecord | null> {
  if (!inviteId || !inviteAdapter) {
    return null;
  }
  const invite = await inviteAdapter.getById(inviteId);
  if (!invite || invite.maxUses == null) return invite;
  return inviteAdapter.update(invite.id, {
    usesRemaining: Math.min(invite.maxUses, (invite.usesRemaining ?? invite.maxUses) + 1),
  });
}

/**
 * Build the `claimInviteSlot` handler bound to a refs bag.
 *
 * The route is disabled in the entity config — this handler is exposed only
 * for completeness; the only real caller is `createRedeemInviteHandler`
 * below, which uses `claimInviteSlot` directly.
 */
export function createClaimInviteSlotHandler(
  refs: Pick<CommunityAdapterRefs, 'invite'>,
): (input: unknown) => Promise<InviteRecord | null> {
  return async input => {
    const params = (input ?? {}) as { id?: string };
    return claimInviteSlot(refs.invite, params.id);
  };
}

/**
 * Build the `releaseInviteSlot` handler bound to a refs bag.
 *
 * Same disabled-route caveat as {@link createClaimInviteSlotHandler}.
 */
export function createReleaseInviteSlotHandler(
  refs: Pick<CommunityAdapterRefs, 'invite'>,
): (input: unknown) => Promise<InviteRecord | null> {
  return async input => {
    const params = (input ?? {}) as { id?: string };
    return releaseInviteSlot(refs.invite, params.id);
  };
}

/**
 * Permissions adapter slice consumed by `createRedeemInviteHandler`.
 *
 * Lets the redemption flow issue a per-user grant on the invite's container
 * without leaking the full {@link PermissionsState} surface.
 */
export interface RedeemPermissionsAdapter {
  createGrant(input: Record<string, unknown>): Promise<string>;
}

export interface CreateRedeemHandlerArgs {
  refs: CommunityAdapterRefs;
  permissionsAdapter: RedeemPermissionsAdapter;
  tenantId?: string;
}

/**
 * Build the `redeemInvite` handler — the bespoke route mounted at
 * `POST /:mount/container-invites/redeem`.
 *
 * Lifts the manifest's `community.containerInvite.redeemInvite` handler into
 * a plain async function bound to the refs bag and an injected permissions
 * adapter. Behavior matches the manifest version exactly: token lookup,
 * revoke/expiry checks, idempotent membership probe, atomic claim/release,
 * member creation, best-effort grant.
 */
export function createRedeemInviteHandler(args: CreateRedeemHandlerArgs) {
  const { refs, permissionsAdapter, tenantId } = args;
  return async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const token = typeof params.token === 'string' ? params.token : '';
    const userId = getUserId(params);
    if (!token) {
      throw new HTTPException(400, { message: 'token is required' });
    }
    if (!refs.invite || !refs.member || !refs.container) {
      throw new Error(
        '[slingshot-community] Invite redemption executed before adapters were captured',
      );
    }
    const invite = await refs.invite.findByToken({ token });
    if (!invite) {
      throw new HTTPException(404, { message: 'Invite not found' });
    }
    if (invite.revokedAt) {
      throw new HTTPException(410, { message: 'Invite has been revoked' });
    }
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new HTTPException(410, { message: 'Invite has expired' });
    }
    const existing = await refs.member.getMember({
      containerId: invite.containerId,
      userId,
    });
    if (existing) {
      const container = await refs.container.getById(invite.containerId);
      return { container, member: existing, alreadyMember: true };
    }

    const claimed = await claimInviteSlot(refs.invite, invite.id);
    if (invite.maxUses != null && !claimed) {
      throw new HTTPException(410, { message: 'Invite has reached its use limit' });
    }

    let member: unknown;
    try {
      member = await refs.member.create({
        containerId: invite.containerId,
        userId,
        role: 'member',
      });
    } catch (error) {
      await releaseInviteSlot(refs.invite, invite.id).catch(() => {});
      throw error;
    }

    await permissionsAdapter
      .createGrant({
        subjectId: userId,
        subjectType: 'user',
        resourceType: 'community:container',
        resourceId: invite.containerId,
        tenantId,
        roles: ['member'],
        effect: 'allow',
        grantedBy: invite.createdBy,
      })
      .catch(() => {});

    const container = await refs.container.getById(invite.containerId);
    return { container, member, alreadyMember: false };
  };
}

// ---------------------------------------------------------------------------
// BareEntityAdapter helpers
// ---------------------------------------------------------------------------

/**
 * Cast a `BareEntityAdapter` into one of the specific community adapter
 * shapes. The bare adapter is structurally a superset of every shape we use
 * (CRUD + named operation methods), so this is a narrowing assertion rather
 * than a real conversion.
 */
export function asAdapter<T>(adapter: BareEntityAdapter): T {
  return adapter as unknown as T;
}
