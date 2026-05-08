import './events';

/**
 * Create the community plugin with containers, threads, replies, reactions,
 * moderation, reports, bans, invites, subscriptions, and notification hooks.
 */
export { createCommunityPlugin } from './plugin';
/**
 * Plugin instance returned by `createCommunityPlugin()`. Extends `SlingshotPlugin`
 * with the WebSocket subscribe-guard and incoming-handler builders that callers
 * can use when wiring the WS endpoint manually.
 */
export type { CommunityPlugin } from './plugin';

/**
 * Provider-owned package contract. Cross-package consumers resolve
 * `CommunityInteractionsPeerCap` through `ctx.capabilities.require(...)`
 * instead of reaching into plugin state.
 */
export { Community, CommunityEntities, CommunityInteractionsPeerCap } from './public';
/**
 * Cross-package peer surface used to resolve community-owned message trees and
 * apply component updates returned by interaction dispatchers.
 */
export type { CommunityInteractionsPeer } from './public';

/**
 * Entity manifest describing the community entities and their wiring graph.
 */
export { communityManifest } from './manifest/communityManifest';

/**
 * Zod schema and the default scoring config used to validate community plugin
 * configuration.
 */
export { communityPluginConfigSchema, DEFAULT_SCORING_CONFIG } from './types/config';
/**
 * Configuration shape, WS config, admin gates, moderation decisions/targets,
 * and scoring config types accepted by `createCommunityPlugin()`.
 */
export type {
  CommunityPluginConfig,
  CommunityWsConfig,
  CommunityAdminGate,
  ModerationDecision,
  ModerationTarget,
  ScoringConfig,
} from './types/config';

/**
 * Runtime state shape published into `pluginState` under
 * `COMMUNITY_PLUGIN_STATE_KEY`. Prefer the public contract
 * (`CommunityInteractionsPeerCap`) for cross-package access; this slot exists
 * for back-compat with `getPublishedInteractionsPeerOrNull` consumers.
 */
export type { CommunityPluginState } from './types/state';
export { CommunityPluginStateRef } from './types/state';
/**
 * Plugin state key for looking up community state in `ctx.pluginState`.
 */
export { COMMUNITY_PLUGIN_STATE_KEY } from './types/state';

/**
 * Hook contracts for before/after route extension points exposed by community
 * entity routes.
 */
export type { BeforeHook, AfterHook } from './types/hooks';

/**
 * Entity record types and list/search options used by community routes and
 * adapter consumers.
 */
export type {
  Container,
  Thread,
  Reply,
  Reaction,
  ContainerMember,
  ContainerRule,
  Report,
  Ban,
  ReactionSummary,
  ReactionType,
  ThreadStatus,
  ReplyStatus,
  ContainerMemberRole,
  ReportTargetType,
  ReportStatus,
  ListContainersOptions,
  ListThreadsOptions,
  GetRepliesOptions,
  ListReportsOptions,
  ListBansOptions,
  SearchOptions,
} from './types/models';

/** Container entity config and generated operations. */
export { Container as ContainerEntity, containerOperations, containerModule } from './entities/container';
/** Thread entity config and generated operations. */
export { Thread as ThreadEntity, threadOperations, threadModule } from './entities/thread';
/** Reply entity config and generated operations. */
export { Reply as ReplyEntity, replyOperations, replyModule } from './entities/reply';
/** Reaction entity config and generated operations. */
export { Reaction as ReactionEntity, reactionOperations, reactionModule } from './entities/reaction';
/** ContainerMember entity config and generated operations. */
export {
  ContainerMember as ContainerMemberEntity,
  containerMemberOperations,
  containerMemberModule,
} from './entities/containerMember';
/** ContainerRule entity config and generated operations. */
export {
  ContainerRule as ContainerRuleEntity,
  containerRuleOperations,
} from './entities/containerRule';
/** Report entity config and generated operations. */
export { Report as ReportEntity, reportOperations } from './entities/report';
/** Ban entity config and generated operations. */
export { Ban as BanEntity, banOperations } from './entities/ban';
/** Tag entity config and generated operations. */
export { Tag as TagEntity, tagOperations } from './entities/tag';
/** ThreadTag entity config and generated operations. */
export { ThreadTag as ThreadTagEntity, threadTagOperations } from './entities/threadTag';
/** ContainerInvite entity config and generated operations. */
export {
  ContainerInvite as ContainerInviteEntity,
  containerInviteOperations,
} from './entities/containerInvite';
/** ContainerSubscription entity config and generated operations. */
export {
  ContainerSubscription as ContainerSubscriptionEntity,
  containerSubscriptionOperations,
} from './entities/containerSubscription';
/** ThreadSubscription entity config and generated operations. */
export {
  ThreadSubscription as ThreadSubscriptionEntity,
  threadSubscriptionOperations,
} from './entities/threadSubscription';
/** UserMute entity config and generated operations. */
export { UserMute as UserMuteEntity, userMuteOperations } from './entities/userMute';
/** Bookmark entity config and generated operations. */
export { Bookmark as BookmarkEntity, bookmarkOperations } from './entities/bookmark';
/** AutoModRule entity config and generated operations. */
export { AutoModRule as AutoModRuleEntity, autoModRuleOperations } from './entities/autoModRule';
/** Warning entity config and generated operations. */
export { Warning as WarningEntity, warningOperations } from './entities/warning';
/** AuditLogEntry entity config and generated operations. */
export {
  AuditLogEntry as AuditLogEntryEntity,
  auditLogEntryOperations,
} from './entities/auditLogEntry';
/** ContainerSetting entity config and generated operations. */
export {
  ContainerSetting as ContainerSettingEntity,
  containerSettingOperations,
} from './entities/containerSetting';

/**
 * Entity factory registries for resolving repos against the active store
 * backend. Used by manifest runtime and tests; most app code does not need
 * these directly.
 */
export {
  containerFactories,
  threadFactories,
  replyFactories,
  reactionFactories,
  containerMemberFactories,
  containerRuleFactories,
  reportFactories,
  banFactories,
  tagFactories,
  threadTagFactories,
  containerInviteFactories,
  containerSubscriptionFactories,
  threadSubscriptionFactories,
  userMuteFactories,
  bookmarkFactories,
  autoModRuleFactories,
  warningFactories,
  auditLogEntryFactories,
  containerSettingFactories,
} from './entities/factories';
