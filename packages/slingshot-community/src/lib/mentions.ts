import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';
import { extractMentionsFromBody } from '@lastshotlabs/slingshot-core/content';
import type { Reply, Thread } from '../types/models';

/**
 * Runtime dependencies required by {@link notifyMentions}.
 *
 * All entity adapters must target the same store backend that is active for the
 * community plugin.
 */
export interface NotifyMentionsDeps {
  /**
   * Builder for creating shared notifications scoped to the `community` source.
   */
  builder: NotificationBuilder;
  /**
   * Adapter for the `Thread` entity — used to load the thread when
   * `source === 'thread'` to extract title and body for mention scanning.
   */
  threadAdapter: EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;
  /**
   * Adapter for the `Reply` entity — used to load the reply when
   * `source === 'reply'` to extract body and parent thread ID.
   */
  replyAdapter: EntityAdapter<Reply, Record<string, unknown>, Record<string, unknown>>;
}

/**
 * Parse mentions from thread or reply content and create one shared
 * notification per unique mentioned user.
 *
 * Called from the community plugin's `afterCreateThread` / `afterCreateReply`
 * hooks (or equivalent event handlers). The function loads the source entity
 * to extract the text content, reads the `mentions` field if present, and
 * falls back to parsing `<@userId>` tokens from the body via
 * `extractMentionsFromBody()`. Creates a `'mention'` notification for each
 * token except the author's own ID (no self-notifications).
 *
 * @param payload - The event payload from the entity create event. Must
 *   contain `id` (the created entity's primary key) and `authorId` (the
 *   creating user's ID). Optionally contains `tenantId` for multi-tenant
 *   scoping.
 * @param deps - Adapters and bus needed to load entities, persist
 *   notifications. See {@link NotifyMentionsDeps}.
 * @param source - Whether the payload describes a `'thread'` or a `'reply'`.
 *   Determines which adapter is used to load content and which fields are
 *   scanned for mentions.
 * @returns A promise that resolves when all notifications have been created.
 *   Resolves immediately (no-op) when `id` or `authorId` is absent from the
 *   payload, or when the source entity cannot be found, or when no mentions
 *   are present.
 *
 * @example
 * ```ts
 * // Inside afterCreateThread hook:
 * await notifyMentions(
 *   { id: thread.id, authorId: thread.authorId, tenantId: thread.tenantId },
 *   { builder, threadAdapter, replyAdapter },
 *   'thread',
 * );
 * ```
 */
export async function notifyMentions(
  payload: Record<string, unknown>,
  deps: NotifyMentionsDeps,
  source: 'thread' | 'reply',
): Promise<void> {
  const id = payload.id as string | undefined;
  const actorId = payload.authorId as string | undefined;
  if (!id || !actorId) return;

  const tenantId = payload.tenantId as string | undefined;

  let mentions: readonly string[] | undefined;
  let body: string | undefined;
  let threadId: string | undefined;
  let containerId: string | undefined;

  if (source === 'thread') {
    const thread = await deps.threadAdapter.getById(id);
    if (!thread) return;
    mentions = thread.mentions;
    body = thread.body ?? undefined;
    threadId = thread.id;
    containerId = thread.containerId;
  } else {
    const reply = await deps.replyAdapter.getById(id);
    if (!reply) return;
    mentions = reply.mentions;
    body = reply.body;
    threadId = reply.threadId;
    containerId = reply.containerId;
  }

  // Prefer explicit mentions array; fall back to parsing body tokens.
  const tokens =
    mentions && mentions.length > 0 ? mentions : body ? extractMentionsFromBody(body) : [];

  if (tokens.length === 0) return;

  for (const token of tokens) {
    // Skip self-mentions.
    if (token === actorId) continue;

    await deps.builder.notify({
      tenantId,
      userId: token,
      type: 'community:mention',
      actorId,
      targetType: source === 'thread' ? 'community:thread' : 'community:reply',
      targetId: id,
      scopeId: containerId,
      dedupKey: `community:mention:${source}:${id}:${token}`,
      data: { source, threadId, containerId },
    });
  }
}
