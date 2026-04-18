import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { AuditLogEntry, auditLogEntryOperations } from '../entities/auditLogEntry';
import { AutoModRule, autoModRuleOperations } from '../entities/autoModRule';
import { Ban, banOperations } from '../entities/ban';
import { Bookmark, bookmarkOperations } from '../entities/bookmark';
import { Container, containerOperations } from '../entities/container';
import { ContainerInvite, containerInviteOperations } from '../entities/containerInvite';
import { ContainerMember, containerMemberOperations } from '../entities/containerMember';
import { ContainerRule, containerRuleOperations } from '../entities/containerRule';
import { ContainerSetting, containerSettingOperations } from '../entities/containerSetting';
import {
  ContainerSubscription,
  containerSubscriptionOperations,
} from '../entities/containerSubscription';
import { Reaction, reactionOperations } from '../entities/reaction';
import { Reply, replyOperations } from '../entities/reply';
import { Report, reportOperations } from '../entities/report';
import { Tag, tagOperations } from '../entities/tag';
import { Thread, threadOperations } from '../entities/thread';
import { ThreadSubscription, threadSubscriptionOperations } from '../entities/threadSubscription';
import { ThreadTag, threadTagOperations } from '../entities/threadTag';
import { UserMute, userMuteOperations } from '../entities/userMute';
import { Warning, warningOperations } from '../entities/warning';

const containerChannels = {
  channels: {
    live: {
      auth: 'userAuth' as const,
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

/**
 * Manifest export for Slingshot community entities.
 *
 * Runtime-only moderation, notifications, invite redemption, and reaction
 * scoring stay package-owned through `createCommunityManifestRuntime()`.
 */
export const communityManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'community',
  hooks: {
    afterAdapters: [{ handler: 'community.captureAdapters' }],
  },
  entities: {
    Container: entityConfigToManifestEntry(Container, {
      operations: containerOperations.operations,
      channels: containerChannels,
    }),
    Thread: entityConfigToManifestEntry(Thread, {
      operations: threadOperations.operations,
      operationOverrides: {
        searchInContainer: {
          kind: 'custom',
          handler: 'community.thread.searchInContainer',
          http: { method: 'get', path: 'container/:containerId/threads/search' },
        },
        listByContainerSorted: {
          kind: 'custom',
          handler: 'community.thread.listByContainerSorted',
          http: { method: 'get', path: 'container/:containerId/threads' },
        },
      },
    }),
    Reply: entityConfigToManifestEntry(Reply, {
      operations: replyOperations.operations,
    }),
    Reaction: entityConfigToManifestEntry(Reaction, {
      operations: reactionOperations.operations,
      operationOverrides: {
        updateScore: {
          kind: 'custom',
          handler: 'community.reaction.updateScore',
        },
      },
    }),
    ContainerMember: entityConfigToManifestEntry(ContainerMember, {
      operations: containerMemberOperations.operations,
    }),
    ContainerRule: entityConfigToManifestEntry(ContainerRule, {
      operations: containerRuleOperations.operations,
    }),
    Report: entityConfigToManifestEntry(Report, {
      operations: reportOperations.operations,
    }),
    Ban: entityConfigToManifestEntry(Ban, {
      operations: banOperations.operations,
    }),
    Tag: entityConfigToManifestEntry(Tag, {
      operations: tagOperations.operations,
    }),
    ThreadTag: entityConfigToManifestEntry(ThreadTag, {
      operations: threadTagOperations.operations,
    }),
    ContainerInvite: entityConfigToManifestEntry(ContainerInvite, {
      operations: containerInviteOperations.operations,
      operationOverrides: {
        redeemInvite: {
          kind: 'custom',
          handler: 'community.containerInvite.redeemInvite',
          http: { method: 'post', path: 'redeem' },
        },
        claimInviteSlot: {
          kind: 'custom',
          handler: 'community.containerInvite.claimInviteSlot',
        },
        releaseInviteSlot: {
          kind: 'custom',
          handler: 'community.containerInvite.releaseInviteSlot',
        },
      },
    }),
    ContainerSubscription: entityConfigToManifestEntry(ContainerSubscription, {
      operations: containerSubscriptionOperations.operations,
    }),
    ThreadSubscription: entityConfigToManifestEntry(ThreadSubscription, {
      operations: threadSubscriptionOperations.operations,
    }),
    UserMute: entityConfigToManifestEntry(UserMute, {
      operations: userMuteOperations.operations,
    }),
    Bookmark: entityConfigToManifestEntry(Bookmark, {
      operations: bookmarkOperations.operations,
    }),
    AutoModRule: entityConfigToManifestEntry(AutoModRule, {
      operations: autoModRuleOperations.operations,
    }),
    Warning: entityConfigToManifestEntry(Warning, {
      operations: warningOperations.operations,
    }),
    AuditLogEntry: entityConfigToManifestEntry(AuditLogEntry, {
      operations: auditLogEntryOperations.operations,
    }),
    ContainerSetting: entityConfigToManifestEntry(ContainerSetting, {
      operations: containerSettingOperations.operations,
    }),
  },
};
