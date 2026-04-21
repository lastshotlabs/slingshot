import './events';

export { createCommunityPlugin } from './plugin';
export type { CommunityPlugin } from './plugin';
export { communityManifest } from './manifest/communityManifest';
export { communityPluginConfigSchema, DEFAULT_SCORING_CONFIG } from './types/config';
export type {
  CommunityPluginConfig,
  CommunityWsConfig,
  CommunityAdminGate,
  ModerationDecision,
  ModerationTarget,
  ScoringConfig,
} from './types/config';
export type { CommunityPluginState, CommunityInteractionsPeer } from './types/state';
export { COMMUNITY_PLUGIN_STATE_KEY } from './types/state';
export type { BeforeHook, AfterHook } from './types/hooks';
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

// Entity definitions + operations (config-driven)
export { Container as ContainerEntity, containerOperations } from './entities/container';
export { Thread as ThreadEntity, threadOperations } from './entities/thread';
export { Reply as ReplyEntity, replyOperations } from './entities/reply';
export { Reaction as ReactionEntity, reactionOperations } from './entities/reaction';
export {
  ContainerMember as ContainerMemberEntity,
  containerMemberOperations,
} from './entities/containerMember';
export {
  ContainerRule as ContainerRuleEntity,
  containerRuleOperations,
} from './entities/containerRule';
export { Report as ReportEntity, reportOperations } from './entities/report';
export { Ban as BanEntity, banOperations } from './entities/ban';
export { Tag as TagEntity, tagOperations } from './entities/tag';
export { ThreadTag as ThreadTagEntity, threadTagOperations } from './entities/threadTag';
export {
  ContainerInvite as ContainerInviteEntity,
  containerInviteOperations,
} from './entities/containerInvite';
export {
  ContainerSubscription as ContainerSubscriptionEntity,
  containerSubscriptionOperations,
} from './entities/containerSubscription';
export {
  ThreadSubscription as ThreadSubscriptionEntity,
  threadSubscriptionOperations,
} from './entities/threadSubscription';
export { UserMute as UserMuteEntity, userMuteOperations } from './entities/userMute';
export { Bookmark as BookmarkEntity, bookmarkOperations } from './entities/bookmark';
export { AutoModRule as AutoModRuleEntity, autoModRuleOperations } from './entities/autoModRule';
export { Warning as WarningEntity, warningOperations } from './entities/warning';
export {
  AuditLogEntry as AuditLogEntryEntity,
  auditLogEntryOperations,
} from './entities/auditLogEntry';
export {
  ContainerSetting as ContainerSettingEntity,
  containerSettingOperations,
} from './entities/containerSetting';

// Entity factories (for resolving repos)
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
