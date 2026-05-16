/**
 * Package-authoring entity modules for the community package.
 *
 * Each entity uses `wiring: { mode: 'manual', buildAdapter }` so the package
 * factory can:
 *
 *   - Resolve the config-driven adapter via the framework's standard factory
 *     pipeline (the same path the standard wiring mode uses internally).
 *   - Publish the resolved adapter into the shared
 *     {@link CommunityAdapterRefs} bag so adapter-dependent middleware
 *     (banCheck, autoMod, threadStateGuard, …) and the bespoke custom-op
 *     handlers (`redeemInvite`, mention attach, embed unfurl, …) all see the
 *     same instance.
 *
 * The bespoke `redeemInvite` route is wired through `overrides.operations` on
 * the ContainerInvite module — the route's auth/permission/middleware come
 * straight from the entity's `routes.operations.redeemInvite` config so the
 * HTTP contract is unchanged.
 *
 * @internal
 */
import type {
  EntityChannelConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityRouteExecutionContext,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorOverrides,
} from '@lastshotlabs/slingshot-entity';
import { AuditLogEntry, auditLogEntryOperations } from './auditLogEntry';
import { AutoModRule, autoModRuleOperations } from './autoModRule';
import { Ban, banOperations } from './ban';
import { Bookmark, bookmarkOperations } from './bookmark';
import { Container, containerOperations } from './container';
import { ContainerInvite, containerInviteOperations } from './containerInvite';
import { ContainerMember, containerMemberOperations } from './containerMember';
import { ContainerRule, containerRuleOperations } from './containerRule';
import { ContainerSetting, containerSettingOperations } from './containerSetting';
import {
  ContainerSubscription,
  containerSubscriptionOperations,
} from './containerSubscription';
import { Reaction, reactionOperations } from './reaction';
import { Reply, replyOperations } from './reply';
import { Report, reportOperations } from './report';
import { Tag, tagOperations } from './tag';
import { Thread, threadOperations } from './thread';
import { ThreadSubscription, threadSubscriptionOperations } from './threadSubscription';
import { ThreadTag, threadTagOperations } from './threadTag';
import { UserMute, userMuteOperations } from './userMute';
import { Warning, warningOperations } from './warning';
import {
  type CommunityAdapterRefs,
  type RedeemPermissionsAdapter,
  asAdapter,
  createRedeemInviteHandler,
} from './runtime';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter via the framework's standard-wiring code
 * path so manual-wiring entities here behave the same as the default factory
 * pipeline.
 */
function resolveStandardAdapter(args: {
  config: Parameters<typeof createEntityFactories>[0];
  operations?: Parameters<typeof createEntityFactories>[1];
  storeType: StoreType;
  infra: StoreInfra;
}): BareEntityAdapter {
  const creator = Reflect.get(args.infra as object, RESOLVE_ENTITY_FACTORIES) as
    | EntityFactoryCreator
    | undefined;
  const factoryCreator = creator ?? createEntityFactories;
  const factories = args.operations
    ? factoryCreator(args.config, args.operations)
    : factoryCreator(args.config);
  return resolveRepo(factories, args.storeType, args.infra) as unknown as BareEntityAdapter;
}

const containerChannels: EntityChannelConfig = {
  channels: {
    live: {
      auth: 'userAuth',
      permission: {
        requires: 'community:container.read',
      },
      presence: true,
      forward: {
        events: [
          'community:thread.created',
          'community:thread.updated',
          'community:thread.deleted',
          'community:thread.published',
          'community:thread.locked',
          'community:thread.unlocked',
          'community:thread.pinned',
          'community:thread.unpinned',
          'community:thread.solved',
          'community:thread.unsolved',
          'community:thread.tagged',
          'community:thread.untagged',
          'community:thread.embeds.resolved',
          'community:reply.created',
          'community:reply.deleted',
          'community:reply.embeds.resolved',
          'community:reaction.added',
          'community:reaction.removed',
          'community:member.joined',
          'community:member.left',
          'community:rule.created',
          'community:rule.updated',
          'community:rule.deleted',
          'community:invite.redeemed',
          'community:user.banned',
          'community:user.unbanned',
        ],
        idField: 'containerId',
      },
      receive: {
        events: ['document.typing', 'thread.typing'],
        toRoom: true,
        excludeSender: true,
      },
    },
  },
};

export interface BuildCommunityEntityModulesArgs {
  /** Shared adapter refs populated as each entity is wired. */
  refs: CommunityAdapterRefs;
  /** Permissions adapter used by the `redeemInvite` handler. */
  permissionsAdapter: RedeemPermissionsAdapter;
  /** Tenant id propagated to the per-invite grant on redemption. */
  tenantId?: string;
}

/**
 * Build every community entity module. Returns the 19-entity tuple ready for
 * `definePackage({ entities: [...] })`.
 */
export function buildCommunityEntityModules(args: BuildCommunityEntityModulesArgs) {
  const { refs, permissionsAdapter, tenantId } = args;

  // ─── Container ─────────────────────────────────────────────────────────────
  const containerModule = entity({
    config: Container,
    operations: containerOperations,
    channels: containerChannels,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Container,
          operations: containerOperations.operations,
          storeType,
          infra,
        });
        refs.container = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Thread ────────────────────────────────────────────────────────────────
  const threadModule = entity({
    config: Thread,
    operations: threadOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Thread,
          operations: threadOperations.operations,
          storeType,
          infra,
        });
        refs.thread = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Reply ─────────────────────────────────────────────────────────────────
  const replyModule = entity({
    config: Reply,
    operations: replyOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Reply,
          operations: replyOperations.operations,
          storeType,
          infra,
        });
        refs.reply = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Reaction ──────────────────────────────────────────────────────────────
  // The `updateScore` op.custom is intentionally route-disabled and has no
  // adapter wiring — the custom-handler is dormant and never invoked at runtime.
  const reactionModule = entity({
    config: Reaction,
    operations: reactionOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Reaction,
          operations: reactionOperations.operations,
          storeType,
          infra,
        });
        refs.reaction = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── ContainerMember ───────────────────────────────────────────────────────
  const containerMemberModule = entity({
    config: ContainerMember,
    operations: containerMemberOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: ContainerMember,
          operations: containerMemberOperations.operations,
          storeType,
          infra,
        });
        refs.member = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── ContainerRule ─────────────────────────────────────────────────────────
  const containerRuleModule = entity({
    config: ContainerRule,
    operations: containerRuleOperations,
  });

  // ─── Report ────────────────────────────────────────────────────────────────
  const reportModule = entity({
    config: Report,
    operations: reportOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Report,
          operations: reportOperations.operations,
          storeType,
          infra,
        });
        refs.report = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Ban ───────────────────────────────────────────────────────────────────
  const banModule = entity({
    config: Ban,
    operations: banOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: Ban,
          operations: banOperations.operations,
          storeType,
          infra,
        });
        refs.ban = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Tag ───────────────────────────────────────────────────────────────────
  const tagModule = entity({
    config: Tag,
    operations: tagOperations,
  });

  // ─── ThreadTag ─────────────────────────────────────────────────────────────
  const threadTagModule = entity({
    config: ThreadTag,
    operations: threadTagOperations,
  });

  // ─── ContainerInvite ───────────────────────────────────────────────────────
  const redeemHandler = createRedeemInviteHandler({
    refs,
    permissionsAdapter,
    ...(tenantId !== undefined ? { tenantId } : {}),
  });

  const wrapHandler =
    (handler: (input: unknown) => Promise<unknown>): EntityRouteExecutorBuilder =>
    () =>
    async (ctx: EntityRouteExecutionContext) => {
      const result = await handler(ctx.input);
      if (result === null) {
        return ctx.respond.json(null);
      }
      return ctx.respond.json(result as Record<string, unknown>);
    };

  const containerInviteOverrides: EntityRouteExecutorOverrides = {
    operations: {
      redeemInvite: wrapHandler(redeemHandler),
    },
  };

  const containerInviteModule = entity({
    config: ContainerInvite,
    operations: containerInviteOperations,
    overrides: containerInviteOverrides,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: ContainerInvite,
          operations: containerInviteOperations.operations,
          storeType,
          infra,
        });
        refs.invite = asAdapter(adapter);
        return adapter;
      },
    },
  });

  // ─── Subscriptions / mutes / bookmarks / tags ──────────────────────────────
  const containerSubscriptionModule = entity({
    config: ContainerSubscription,
    operations: containerSubscriptionOperations,
  });

  const threadSubscriptionModule = entity({
    config: ThreadSubscription,
    operations: threadSubscriptionOperations,
  });

  const userMuteModule = entity({
    config: UserMute,
    operations: userMuteOperations,
  });

  const bookmarkModule = entity({
    config: Bookmark,
    operations: bookmarkOperations,
  });

  // ─── Moderation / audit ────────────────────────────────────────────────────
  const autoModRuleModule = entity({
    config: AutoModRule,
    operations: autoModRuleOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: AutoModRule,
          operations: autoModRuleOperations.operations,
          storeType,
          infra,
        });
        refs.autoModRule = asAdapter(adapter);
        return adapter;
      },
    },
  });

  const warningModule = entity({
    config: Warning,
    operations: warningOperations,
  });

  const auditLogEntryModule = entity({
    config: AuditLogEntry,
    operations: auditLogEntryOperations,
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: AuditLogEntry,
          operations: auditLogEntryOperations.operations,
          storeType,
          infra,
        });
        refs.auditLog = asAdapter(adapter);
        return adapter;
      },
    },
  });

  const containerSettingModule = entity({
    config: ContainerSetting,
    operations: containerSettingOperations,
  });

  return {
    containerModule,
    threadModule,
    replyModule,
    reactionModule,
    containerMemberModule,
    containerRuleModule,
    reportModule,
    banModule,
    tagModule,
    threadTagModule,
    containerInviteModule,
    containerSubscriptionModule,
    threadSubscriptionModule,
    userMuteModule,
    bookmarkModule,
    autoModRuleModule,
    warningModule,
    auditLogEntryModule,
    containerSettingModule,
  };
}
