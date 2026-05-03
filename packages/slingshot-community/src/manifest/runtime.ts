import { HTTPException } from 'hono/http-exception';
import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import { createAuditLogMiddleware } from '../middleware/auditLog';
import { createAutoModMiddleware } from '../middleware/autoMod';
import { createBanCheckMiddleware } from '../middleware/banCheck';
import { createContentTargetGuardMiddleware } from '../middleware/contentTargetGuard';
import { createMemberJoinPolicyGuardMiddleware } from '../middleware/memberJoinPolicyGuard';
import { createPublishedThreadGuardMiddleware } from '../middleware/publishedThreadGuard';
import { createReplyCountDecrementMiddleware } from '../middleware/replyCountDecrement';
import { createReplyCountUpdateMiddleware } from '../middleware/replyCountUpdate';
import { createSolutionReplyGuardMiddleware } from '../middleware/solutionReplyGuard';
import { createThreadStateGuardMiddleware } from '../middleware/threadStateGuard';
import {
  createListSortedMemoryHandler,
  createListSortedMongoHandler,
  createListSortedPostgresHandler,
  createListSortedRedisHandler,
  createListSortedSqliteHandler,
} from '../operations/listByContainerSorted';
import {
  createSearchInContainerMemoryHandler,
  createSearchInContainerMongoHandler,
  createSearchInContainerPostgresHandler,
  createSearchInContainerRedisHandler,
  createSearchInContainerSqliteHandler,
} from '../operations/searchInContainer';
import { createUpdateScoreHandler } from '../operations/updateScore';
import type {
  CommunityAdminGate,
  ModerationDecision,
  ModerationTarget,
  ScoringConfig,
} from '../types/config';

type CommunityHandler = (...args: unknown[]) => Promise<unknown>;

type ContainerAdapter = {
  getById(id: string): Promise<{ id: string; joinPolicy?: string; deletedAt?: unknown } | null>;
};

type ThreadAdapter = {
  getById(
    id: string,
  ): Promise<{ createdAt?: string | Date; containerId: string; status?: string } | null>;
  incrementReplyCount(id: string): Promise<unknown>;
  decrementReplyCount(id: string): Promise<unknown>;
  updateLastActivity(
    match: { id: string },
    data: { lastActivityAt?: string; lastReplyById?: string; lastReplyAt?: string },
  ): Promise<unknown>;
  update(id: string, data: unknown): Promise<unknown>;
  updateComponents(match: { id: string }, data: { components?: unknown }): Promise<unknown>;
};

type ReplyAdapter = {
  getById(id: string): Promise<{
    createdAt?: string | Date;
    threadId?: string;
    containerId: string;
    status?: string;
  } | null>;
  update(id: string, data: unknown): Promise<unknown>;
  updateComponents(match: { id: string }, data: { components?: unknown }): Promise<unknown>;
};

type ReactionAdapter = {
  listByTarget(params: { targetId: string; targetType: string }): Promise<{
    items: Array<{ type: string; value?: string | null }>;
  }>;
};

type ContainerMemberAdapter = {
  create(input: { containerId: string; userId: string; role?: string }): Promise<unknown>;
  getMember(params: { containerId: string; userId: string }): Promise<unknown>;
  getById(id: string): Promise<{ role?: string; userId?: string; containerId?: string } | null>;
};

type ReportAdapter = {
  create(input: Record<string, unknown>): Promise<unknown>;
};

type BanAdapter = {
  list(input: { filter: Record<string, unknown>; limit?: number }): Promise<{ items: unknown[] }>;
};

type AuditLogAdapter = {
  create(input: Record<string, unknown>): Promise<unknown>;
};

type AutoModRuleAdapter = {
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

type InviteRecord = {
  id: string;
  containerId: string;
  createdBy: string;
  maxUses?: number | null;
  usesRemaining?: number | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
};

type ContainerInviteAdapter = {
  getById(id: string): Promise<InviteRecord | null>;
  findByToken(params: { token: string }): Promise<InviteRecord | null>;
  update(id: string, input: Record<string, unknown>): Promise<InviteRecord | null>;
};

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
 * Build the manifest runtime for `communityManifest`.
 */
export function createCommunityManifestRuntime(args: {
  scoring: ScoringConfig;
  autoModerationHook?: (
    content: ModerationTarget,
  ) => ModerationDecision | Promise<ModerationDecision>;
  adminGate?: CommunityAdminGate;
  permissionsAdapter: { createGrant(input: Record<string, unknown>): Promise<string> };
  tenantId?: string;
  onAdaptersCaptured: (adapters: {
    container: ContainerAdapter;
    thread: ThreadAdapter;
    reply: ReplyAdapter;
    member: ContainerMemberAdapter;
  }) => void;
  setBanCheckHandler: (handler: import('hono').MiddlewareHandler) => void;
  setAutoModHandler: (handler: import('hono').MiddlewareHandler) => void;
  setThreadStateGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setPublishedThreadGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setTargetVisibilityGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setReportTargetGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setMemberJoinPolicyGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setSolutionReplyGuardHandler: (handler: import('hono').MiddlewareHandler) => void;
  setReplyCountUpdateHandler: (handler: import('hono').MiddlewareHandler) => void;
  setReplyCountDecrementHandler: (handler: import('hono').MiddlewareHandler) => void;
  setAuditLogHandler: (handler: import('hono').MiddlewareHandler) => void;
}): EntityManifestRuntime {
  const {
    scoring,
    autoModerationHook,
    adminGate,
    permissionsAdapter,
    tenantId,
    onAdaptersCaptured,
    setBanCheckHandler,
    setAutoModHandler,
    setThreadStateGuardHandler,
    setPublishedThreadGuardHandler,
    setTargetVisibilityGuardHandler,
    setReportTargetGuardHandler,
    setMemberJoinPolicyGuardHandler,
    setSolutionReplyGuardHandler,
    setReplyCountUpdateHandler,
    setReplyCountDecrementHandler,
    setAuditLogHandler,
  } = args;
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();

  let containerAdapterRef: ContainerAdapter | undefined;
  let threadAdapterRef: ThreadAdapter | undefined;
  let replyAdapterRef: ReplyAdapter | undefined;
  let reactionAdapterRef: ReactionAdapter | undefined;
  let memberAdapterRef: ContainerMemberAdapter | undefined;
  let reportAdapterRef: ReportAdapter | undefined;
  let banAdapterRef: BanAdapter | undefined;
  let auditLogAdapterRef: AuditLogAdapter | undefined;
  let autoModRuleAdapterRef: AutoModRuleAdapter | undefined;
  let inviteAdapterRef: ContainerInviteAdapter | undefined;

  hooks.register('community.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    containerAdapterRef = ctx.adapters.Container as unknown as ContainerAdapter;
    threadAdapterRef = ctx.adapters.Thread as unknown as ThreadAdapter;
    replyAdapterRef = ctx.adapters.Reply as unknown as ReplyAdapter;
    reactionAdapterRef = ctx.adapters.Reaction as unknown as ReactionAdapter;
    memberAdapterRef = ctx.adapters.ContainerMember as unknown as ContainerMemberAdapter;
    reportAdapterRef = ctx.adapters.Report as unknown as ReportAdapter;
    banAdapterRef = ctx.adapters.Ban as unknown as BanAdapter;
    auditLogAdapterRef = ctx.adapters.AuditLogEntry as unknown as AuditLogAdapter | undefined;
    autoModRuleAdapterRef = ctx.adapters.AutoModRule as unknown as AutoModRuleAdapter | undefined;
    inviteAdapterRef = ctx.adapters.ContainerInvite as unknown as ContainerInviteAdapter;

    onAdaptersCaptured({
      container: containerAdapterRef,
      thread: threadAdapterRef,
      reply: replyAdapterRef,
      member: memberAdapterRef,
    });

    setBanCheckHandler(
      createBanCheckMiddleware({
        banAdapter: banAdapterRef as never,
      }),
    );
    setAutoModHandler(
      createAutoModMiddleware({
        autoModerationHook,
        autoModRuleAdapter: autoModRuleAdapterRef,
        reportAdapter: reportAdapterRef as never,
      }),
    );
    setThreadStateGuardHandler(
      createThreadStateGuardMiddleware({
        threadAdapter: threadAdapterRef as never,
      }),
    );
    setPublishedThreadGuardHandler(
      createPublishedThreadGuardMiddleware({
        threadAdapter: threadAdapterRef as never,
      }),
    );
    setTargetVisibilityGuardHandler(
      createContentTargetGuardMiddleware(
        {
          threadAdapter: threadAdapterRef as never,
          replyAdapter: replyAdapterRef as never,
        },
        { requireContainerIdMatch: true },
      ),
    );
    setReportTargetGuardHandler(
      createContentTargetGuardMiddleware(
        {
          threadAdapter: threadAdapterRef as never,
          replyAdapter: replyAdapterRef as never,
        },
        { allowUserTarget: true, attachContainerId: true },
      ),
    );
    setMemberJoinPolicyGuardHandler(
      createMemberJoinPolicyGuardMiddleware({
        containerAdapter: containerAdapterRef,
      }),
    );
    setSolutionReplyGuardHandler(
      createSolutionReplyGuardMiddleware({
        replyAdapter: replyAdapterRef as never,
      }),
    );
    setReplyCountUpdateHandler(
      createReplyCountUpdateMiddleware({
        threadAdapter: threadAdapterRef,
      }),
    );
    setReplyCountDecrementHandler(
      createReplyCountDecrementMiddleware({
        replyAdapter: replyAdapterRef,
        threadAdapter: threadAdapterRef,
      }),
    );
    setAuditLogHandler(
      createAuditLogMiddleware({
        adminGate:
          adminGate ??
          (auditLogAdapterRef
            ? {
                verifyRequest() {
                  return Promise.resolve(null);
                },
                async logAuditEntry(entry) {
                  await auditLogAdapterRef?.create({
                    action: entry.action,
                    actorId: entry.actorId,
                    targetId: entry.targetId,
                    targetType: 'community',
                    tenantId: entry.meta?.tenantId as string | undefined,
                    meta: entry.meta,
                  });
                },
              }
            : undefined),
      }),
    );
  });

  customHandlers.register('community.reaction.updateScore', () => () => {
    const handler = createUpdateScoreHandler({
      listReactions: params => {
        if (!reactionAdapterRef) {
          throw new Error('[slingshot-community] Reaction adapter unavailable for updateScore');
        }
        return reactionAdapterRef.listByTarget(params);
      },
      fetchTarget: async params => {
        if (params.targetType === 'thread') {
          return (await threadAdapterRef?.getById(params.targetId)) ?? null;
        }
        if (params.targetType === 'reply') {
          return (await replyAdapterRef?.getById(params.targetId)) ?? null;
        }
        return null;
      },
      updateTarget: async params => {
        if (params.targetType === 'thread') {
          await threadAdapterRef?.update(params.targetId, {
            score: params.score,
            reactionSummary: params.reactionSummary,
          });
          return;
        }
        if (params.targetType === 'reply') {
          await replyAdapterRef?.update(params.targetId, {
            score: params.score,
            reactionSummary: params.reactionSummary,
          });
        }
      },
      scoring,
    });
    return handler as CommunityHandler;
  });

  customHandlers.register('community.thread.searchInContainer', {
    memory: store =>
      createSearchInContainerMemoryHandler(store as Map<string, Record<string, unknown>>),
    sqlite: db => createSearchInContainerSqliteHandler(db),
    postgres: pool => createSearchInContainerPostgresHandler(pool),
    mongo: collection => createSearchInContainerMongoHandler(collection),
    redis: redis => createSearchInContainerRedisHandler(redis),
  });

  customHandlers.register('community.thread.listByContainerSorted', {
    memory: store => createListSortedMemoryHandler(store as Map<string, Record<string, unknown>>),
    sqlite: db => createListSortedSqliteHandler(db),
    postgres: pool => createListSortedPostgresHandler(pool),
    mongo: collection => createListSortedMongoHandler(collection),
    redis: redis => createListSortedRedisHandler(redis),
  });

  customHandlers.register(
    'community.containerInvite.claimInviteSlot',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as { id?: string };
      return claimInviteSlot(inviteAdapterRef, params.id);
    },
  );

  customHandlers.register(
    'community.containerInvite.releaseInviteSlot',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as { id?: string };
      return releaseInviteSlot(inviteAdapterRef, params.id);
    },
  );

  customHandlers.register(
    'community.containerInvite.redeemInvite',
    () => () => async (input: unknown) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const token = typeof params.token === 'string' ? params.token : '';
      const userId = getUserId(params);
      if (!token) {
        throw new HTTPException(400, { message: 'token is required' });
      }
      if (!inviteAdapterRef || !memberAdapterRef || !containerAdapterRef) {
        throw new Error(
          '[slingshot-community] Invite redemption executed before adapters were captured',
        );
      }
      const invite = await inviteAdapterRef.findByToken({ token });
      if (!invite) {
        throw new HTTPException(404, { message: 'Invite not found' });
      }
      if (invite.revokedAt) {
        throw new HTTPException(410, { message: 'Invite has been revoked' });
      }
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
        throw new HTTPException(410, { message: 'Invite has expired' });
      }
      const existing = await memberAdapterRef.getMember({
        containerId: invite.containerId,
        userId,
      });
      if (existing) {
        const container = await containerAdapterRef.getById(invite.containerId);
        return { container, member: existing, alreadyMember: true };
      }

      const claimed = await claimInviteSlot(inviteAdapterRef, invite.id);
      if (invite.maxUses != null && !claimed) {
        throw new HTTPException(410, { message: 'Invite has reached its use limit' });
      }

      let member;
      try {
        member = await memberAdapterRef.create({
          containerId: invite.containerId,
          userId,
          role: 'member',
        });
      } catch (error) {
        await releaseInviteSlot(inviteAdapterRef, invite.id).catch(() => {});
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

      const container = await containerAdapterRef.getById(invite.containerId);
      return { container, member, alreadyMember: false };
    },
  );

  return {
    customHandlers,
    hooks,
  };
}
