/**
 * Unread message count handler for the `unreadCount` custom operation on RoomMember.
 *
 * Computes per-room unread counts for the authenticated user. A message is
 * "unread" when all of:
 * - `authorId !== userId` (not authored by the user)
 * - `deletedAt` is null (not soft-deleted)
 * - `createdAt > member.lastReadAt` (or all messages if `lastReadAt` is null)
 * - `scheduledAt` is null OR `scheduledDelivered` is true (only delivered)
 *
 * The handler iterates messages once per room (via the `listByRoom` index),
 * so total work is proportional to the number of unread messages across all
 * rooms the user belongs to.
 *
 * @module
 */
import type { PaginatedResult } from '@lastshotlabs/slingshot-core';
import type { Message, RoomMember, UnreadCountEntry, UnreadCountResponse } from '../types';
import { getUserId } from './ctx';

interface UnreadCountDeps {
  memberAdapter: {
    listByUser(params: { userId: string }): Promise<PaginatedResult<RoomMember>>;
  };
  messageAdapter: {
    listByRoom(params: {
      roomId: string;
      cursor?: string;
      limit?: number;
    }): Promise<PaginatedResult<Message>>;
  };
}

function isUnread(msg: Message, userId: string, lastReadAt: string | null | undefined): boolean {
  if (msg.authorId === userId) return false;
  if (msg.deletedAt) return false;
  if (msg.scheduledAt && !msg.scheduledDelivered) return false;
  if (lastReadAt && msg.createdAt <= lastReadAt) return false;
  return true;
}

/**
 * Build the `unreadCount` operation handler.
 *
 * @param deps.memberAdapter - RoomMember adapter for listing user memberships.
 * @param deps.messageAdapter - Message adapter for listing room messages.
 * @returns An async handler that accepts operation params and returns `UnreadCountResponse`.
 */
export function createUnreadCountHandler(
  deps: UnreadCountDeps,
): (params: Record<string, unknown>) => Promise<UnreadCountResponse> {
  return async (params: Record<string, unknown>): Promise<UnreadCountResponse> => {
    const userId = getUserId(params);

    // 1. Get all rooms the user belongs to
    const memberships = await deps.memberAdapter.listByUser({ userId });

    // 2. For each room, count unread messages
    const counts: UnreadCountEntry[] = [];

    for (const membership of memberships.items) {
      const lastReadAt = membership.lastReadAt;
      let count = 0;
      let cursor: string | undefined;

      // Paginate through messages to count unreads
      do {
        const page = await deps.messageAdapter.listByRoom({
          roomId: membership.roomId,
          cursor,
          limit: 100,
        });

        for (const msg of page.items) {
          if (isUnread(msg, userId, lastReadAt)) {
            count++;
          }
        }

        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      if (count > 0) {
        counts.push({ roomId: membership.roomId, count });
      }
    }

    return { counts };
  };
}
