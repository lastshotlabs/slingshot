/**
 * After-middleware for Message create that emits shared chat notifications.
 *
 * Handles three notification flows:
 * 1. **Mention** — `@userId` tokens and `@everyone`/`@here` broadcast mentions.
 * 2. **Reply** — notifies the parent message author when `replyToId` is set.
 * 3. **DM** — notifies the other member in a DM room.
 *
 * Notification rows are stored through `slingshot-notifications`.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';
import { extractMentionTokens } from '../lib/mentions';
import { CHAT_NOTIFICATION_TYPES } from '../lib/notifications';
import type { MessageAdapter, NotifyPreference, RoomAdapter, RoomMemberAdapter } from '../types';

function allowsNotifyOn(memberNotifyOn: NotifyPreference, mode: 'mention' | 'all'): boolean {
  if (memberNotifyOn === 'none') return false;
  return mode === 'mention' ? true : memberNotifyOn === 'all';
}

/**
 * Build the message-notify after-middleware.
 *
 * @param deps - Resolved adapters and source-scoped notification builder.
 * @returns Hono middleware.
 * @internal
 */
export function createMessageNotifyMiddleware(deps: {
  builder: NotificationBuilder;
  roomAdapter: RoomAdapter;
  memberAdapter: RoomMemberAdapter;
  messageAdapter: MessageAdapter;
}): MiddlewareHandler {
  const { builder, roomAdapter, memberAdapter, messageAdapter } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const result = (await c.res.clone().json()) as {
      id?: string;
      roomId?: string;
      authorId?: string | null;
      body?: string;
      replyToId?: string | null;
      mentions?: readonly string[];
      broadcastMentions?: readonly ('everyone' | 'here')[];
      authorName?: string | null;
    } | null;

    if (!result?.id || !result.roomId || !result.authorId) return;

    const room = await roomAdapter.getById(result.roomId);
    if (!room) return;

    const members = await memberAdapter.listByRoom({ roomId: result.roomId });
    const membersByUserId = new Map(members.items.map(member => [member.userId, member]));

    const bodyPreview = result.body?.slice(0, 200) ?? '';
    const actorName = result.authorName ?? 'A user';

    // ── DM notification ──────────────────────────────────────────────────────
    if (room.type === 'dm') {
      const otherMember = members.items.find(
        m => m.userId !== result.authorId && allowsNotifyOn(m.notifyOn, 'all'),
      );
      if (otherMember) {
        await builder.notify({
          userId: otherMember.userId,
          tenantId: room.tenantId ?? undefined,
          type: CHAT_NOTIFICATION_TYPES.dm,
          actorId: result.authorId,
          targetType: 'chat:message',
          targetId: result.id,
          scopeId: result.roomId,
          dedupKey: `chat:dm:${result.roomId}:${result.authorId}`,
          data: { roomId: result.roomId, actorName, bodyPreview },
        });
      }
      // DM rooms don't fire mention or reply notifications.
      return;
    }

    // ── Mention notifications ────────────────────────────────────────────────
    // Use sidecar fields from content-model first, fall back to regex extraction.
    const sidecarMentions = result.mentions ?? [];
    const regexMentions = sidecarMentions.length > 0 ? [] : extractMentionTokens(result.body);
    const userMentions = [...new Set([...sidecarMentions, ...regexMentions])];
    const broadcastMentions = result.broadcastMentions ?? [];

    let recipients: string[] = userMentions.filter(id => id !== result.authorId);

    if (broadcastMentions.length > 0) {
      const baseMembers = members.items
        .filter(m => m.userId !== result.authorId)
        .map(m => m.userId);
      recipients = [...new Set([...recipients, ...baseMembers])];
    }

    // Filter to room members with appropriate notification preferences.
    const verified: string[] = [];
    for (const userId of recipients) {
      const member = membersByUserId.get(userId);
      if (!member) continue;
      if (!allowsNotifyOn(member.notifyOn, 'mention')) continue;
      verified.push(userId);
    }

    if (verified.length > 0) {
      await builder.notifyMany({
        userIds: verified,
        tenantId: room.tenantId ?? undefined,
        type: CHAT_NOTIFICATION_TYPES.mention,
        actorId: result.authorId,
        targetType: 'chat:message',
        targetId: result.id,
        scopeId: result.roomId,
        dedupKey: `chat:mention:${result.id}`,
        data: {
          roomId: result.roomId,
          roomType: room.type,
          replyToId: result.replyToId ?? null,
          actorName,
          bodyPreview,
        },
      });
    }

    // ── Reply notification ───────────────────────────────────────────────────
    if (!result.replyToId) return;

    const parentMessage = await messageAdapter.getById(result.replyToId);
    if (!parentMessage?.authorId || parentMessage.authorId === result.authorId) return;

    const parentMember = membersByUserId.get(parentMessage.authorId);
    if (!parentMember || !allowsNotifyOn(parentMember.notifyOn, 'all')) return;

    await builder.notify({
      userId: parentMessage.authorId,
      tenantId: room.tenantId ?? undefined,
      type: CHAT_NOTIFICATION_TYPES.reply,
      actorId: result.authorId,
      targetType: 'chat:message',
      targetId: result.id,
      scopeId: result.roomId,
      dedupKey: `chat:reply:${result.replyToId}:${result.id}`,
      data: {
        roomId: result.roomId,
        roomType: room.type,
        replyToId: result.replyToId,
        parentMessageId: parentMessage.id,
        actorName,
        bodyPreview,
      },
    });
  };
}
