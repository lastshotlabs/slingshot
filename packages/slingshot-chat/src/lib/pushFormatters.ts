/**
 * Default push notification formatters for chat notification types.
 *
 * Registered with `slingshot-push` during `setupPost`. Consumers can override
 * any formatter by registering their own at a later lifecycle phase —
 * `slingshot-push`'s registry is last-write-wins per type.
 *
 * @module
 */
import { CHAT_NOTIFICATION_TYPES } from './notifications';

/**
 * Minimal interface for the push plugin state needed to register formatters.
 * Avoids a hard import of `@lastshotlabs/slingshot-push` which is an optional peer.
 */
interface PushFormatterRegistry {
  registerFormatter(
    type: string,
    formatter: (
      notification: { targetId: string; data?: Readonly<Record<string, unknown>> },
      defaults?: { icon?: string },
    ) => { title: string; body: string; data?: Record<string, unknown>; icon?: string },
  ): void;
}

/**
 * Register default push formatters for all chat notification types.
 *
 * @param registry - The push plugin state with `registerFormatter`.
 */
export function registerChatPushFormatters(registry: PushFormatterRegistry): void {
  registry.registerFormatter(CHAT_NOTIFICATION_TYPES.mention, (notification, defaults) => ({
    title: (notification.data?.actorName as string | undefined) ?? 'You were mentioned',
    body: (notification.data?.bodyPreview as string | undefined) ?? '',
    data: {
      roomId: notification.data?.roomId as string,
      messageId: notification.targetId,
      __slingshotDeepLink: `/chat/rooms/${notification.data?.roomId as string}/messages/${notification.targetId}`,
    },
    icon: defaults?.icon,
  }));

  registry.registerFormatter(CHAT_NOTIFICATION_TYPES.reply, (notification, defaults) => ({
    title: (notification.data?.actorName as string | undefined) ?? 'New reply',
    body: (notification.data?.bodyPreview as string | undefined) ?? '',
    data: {
      roomId: notification.data?.roomId as string,
      messageId: notification.targetId,
      parentMessageId: notification.data?.parentMessageId as string,
    },
    icon: defaults?.icon,
  }));

  registry.registerFormatter(CHAT_NOTIFICATION_TYPES.dm, (notification, defaults) => ({
    title: (notification.data?.actorName as string | undefined) ?? 'New message',
    body: (notification.data?.bodyPreview as string | undefined) ?? '',
    data: {
      roomId: notification.data?.roomId as string,
      messageId: notification.targetId,
    },
    icon: defaults?.icon,
  }));

  registry.registerFormatter(CHAT_NOTIFICATION_TYPES.invite, (notification, defaults) => ({
    title: 'You were invited to a room',
    body: (notification.data?.roomName as string | undefined) ?? '',
    data: { inviteId: notification.targetId },
    icon: defaults?.icon,
  }));

  registry.registerFormatter(CHAT_NOTIFICATION_TYPES.poll, (notification, defaults) => ({
    title: (notification.data?.actorName as string | undefined) ?? 'New poll',
    body: (notification.data?.question as string | undefined) ?? '',
    data: { pollId: notification.targetId, roomId: notification.data?.roomId as string },
    icon: defaults?.icon,
  }));
}
