import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { AuditLogEntry, auditLogEntryOperations } from './auditLogEntry';
import { AutoModRule, autoModRuleOperations } from './autoModRule';
import { Ban, banOperations } from './ban';
import { Bookmark, bookmarkOperations } from './bookmark';
import { Container, containerOperations } from './container';
import { ContainerInvite, containerInviteOperations } from './containerInvite';
import { ContainerMember, containerMemberOperations } from './containerMember';
import { ContainerRule, containerRuleOperations } from './containerRule';
import { ContainerSetting, containerSettingOperations } from './containerSetting';
import { ContainerSubscription, containerSubscriptionOperations } from './containerSubscription';
import { Reaction, reactionOperations } from './reaction';
import { Reply, replyOperations } from './reply';
import { Report, reportOperations } from './report';
import { Tag, tagOperations } from './tag';
import { Thread, threadOperations } from './thread';
import { ThreadSubscription, threadSubscriptionOperations } from './threadSubscription';
import { ThreadTag, threadTagOperations } from './threadTag';
import { UserMute, userMuteOperations } from './userMute';
import { Warning, warningOperations } from './warning';

/**
 * `RepoFactories` for the Container entity.
 *
 * Dispatch to the right store adapter (memory / postgres / mongo / redis / sqlite)
 * via `resolveRepo(containerFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { containerFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const containerAdapter = resolveRepo(containerFactories, 'postgres', infra);
 * ```
 */
export const containerFactories = createEntityFactories(Container, containerOperations.operations);

/**
 * `RepoFactories` for the Thread entity.
 *
 * Dispatch to the right store adapter via `resolveRepo(threadFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { threadFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const threadAdapter = resolveRepo(threadFactories, 'postgres', infra);
 * ```
 */
export const threadFactories = createEntityFactories(Thread, threadOperations.operations);

/**
 * `RepoFactories` for the Reply entity.
 *
 * Dispatch to the right store adapter via `resolveRepo(replyFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { replyFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const replyAdapter = resolveRepo(replyFactories, 'postgres', infra);
 * ```
 */
export const replyFactories = createEntityFactories(Reply, replyOperations.operations);

/**
 * `RepoFactories` for the Reaction entity.
 *
 * Dispatch to the right store adapter via `resolveRepo(reactionFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { reactionFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const reactionAdapter = resolveRepo(reactionFactories, 'postgres', infra);
 * ```
 */
export const reactionFactories = createEntityFactories(Reaction, reactionOperations.operations);

/**
 * `RepoFactories` for the ContainerMember entity.
 *
 * Dispatch to the right store adapter via
 * `resolveRepo(containerMemberFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { containerMemberFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const memberAdapter = resolveRepo(containerMemberFactories, 'postgres', infra);
 * ```
 */
export const containerMemberFactories = createEntityFactories(
  ContainerMember,
  containerMemberOperations.operations,
);

/**
 * `RepoFactories` for the ContainerRule entity.
 *
 * Dispatch to the right store adapter via
 * `resolveRepo(containerRuleFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { containerRuleFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const ruleAdapter = resolveRepo(containerRuleFactories, 'postgres', infra);
 * ```
 */
export const containerRuleFactories = createEntityFactories(
  ContainerRule,
  containerRuleOperations.operations,
);

/**
 * `RepoFactories` for the Report entity.
 *
 * Dispatch to the right store adapter via `resolveRepo(reportFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { reportFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const reportAdapter = resolveRepo(reportFactories, 'postgres', infra);
 * ```
 */
export const reportFactories = createEntityFactories(Report, reportOperations.operations);

/**
 * `RepoFactories` for the Ban entity.
 *
 * Dispatch to the right store adapter via `resolveRepo(banFactories, storeType, infra)`.
 *
 * @example
 * ```ts
 * import { banFactories } from '@lastshotlabs/slingshot-community';
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const banAdapter = resolveRepo(banFactories, 'postgres', infra);
 * ```
 */
export const banFactories = createEntityFactories(Ban, banOperations.operations);

/** `RepoFactories` for the Tag entity. */
export const tagFactories = createEntityFactories(Tag, tagOperations.operations);

/** `RepoFactories` for the ThreadTag entity. */
export const threadTagFactories = createEntityFactories(ThreadTag, threadTagOperations.operations);

/** `RepoFactories` for the ContainerInvite entity. */
export const containerInviteFactories = createEntityFactories(
  ContainerInvite,
  containerInviteOperations.operations,
);

/** `RepoFactories` for the ContainerSubscription entity. */
export const containerSubscriptionFactories = createEntityFactories(
  ContainerSubscription,
  containerSubscriptionOperations.operations,
);

/** `RepoFactories` for the ThreadSubscription entity. */
export const threadSubscriptionFactories = createEntityFactories(
  ThreadSubscription,
  threadSubscriptionOperations.operations,
);

/** `RepoFactories` for the UserMute entity. */
export const userMuteFactories = createEntityFactories(UserMute, userMuteOperations.operations);

/** `RepoFactories` for the Bookmark entity. */
export const bookmarkFactories = createEntityFactories(Bookmark, bookmarkOperations.operations);

/** `RepoFactories` for the AutoModRule entity. */
export const autoModRuleFactories = createEntityFactories(
  AutoModRule,
  autoModRuleOperations.operations,
);

/** `RepoFactories` for the Warning entity. */
export const warningFactories = createEntityFactories(Warning, warningOperations.operations);

/** `RepoFactories` for the AuditLogEntry entity. */
export const auditLogEntryFactories = createEntityFactories(
  AuditLogEntry,
  auditLogEntryOperations.operations,
);

/** `RepoFactories` for the ContainerSetting entity. */
export const containerSettingFactories = createEntityFactories(
  ContainerSetting,
  containerSettingOperations.operations,
);
