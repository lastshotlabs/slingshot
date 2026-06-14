import './events';

/**
 * Create the community package with containers, threads, replies, reactions,
 * moderation, reports, bans, invites, subscriptions, and notification hooks.
 * Returns a `SlingshotPackageDefinition` ready for `createApp({ packages: [...] })`.
 */
export { createCommunityPackage } from './plugin';

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
 * Zod schema and the default scoring config used to validate community plugin
 * configuration.
 */
export { communityPluginConfigSchema, DEFAULT_SCORING_CONFIG } from './types/config';
/**
 * Configuration shape, WS config, admin gates, moderation decisions/targets,
 * and scoring config types accepted by `createCommunityPackage()`.
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
 * `COMMUNITY_PLUGIN_STATE_KEY`. Cross-package consumers should resolve
 * `CommunityInteractionsPeerCap` instead of reading the slot directly.
 */
export type { CommunityPluginState } from './types/state';
/**
 * Plugin state key under which the community package publishes its runtime
 * state. Load-bearing internal infrastructure for the `probeCommunityPeer` /
 * `getPublishedInteractionsPeerOrNull` bridge in `slingshot-interactions`.
 *
 * @internal Cross-package code should resolve `CommunityInteractionsPeerCap`
 * via `ctx.capabilities.require(...)` instead of reading this slot directly.
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
export {
  Container as ContainerEntity,
  containerOperations,
  containerModule,
} from './entities/container';
/** Thread entity config and generated operations. */
export { Thread as ThreadEntity, threadOperations, threadModule } from './entities/thread';
/** Reply entity config and generated operations. */
export { Reply as ReplyEntity, replyOperations, replyModule } from './entities/reply';
/** Reaction entity config and generated operations. */
export {
  Reaction as ReactionEntity,
  reactionOperations,
  reactionModule,
} from './entities/reaction';
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

// Entity factory registries (`./entities/factories`) are an internal wiring
// detail consumed by `src/testing.ts` and cross-package wiring tests via the
// module path. They are intentionally NOT re-exported from the package root:
// the runtime wires adapters through `buildCommunityEntityModules` (manual
// mode), so app code never needs these directly.
