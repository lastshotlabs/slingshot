/**
 * Chat-specific notification type constants.
 *
 * Centralized so the plugin has one place to update when a new
 * notification type is added.
 *
 * @module
 */

/** Notification types emitted by slingshot-chat. */
export const CHAT_NOTIFICATION_TYPES = {
  mention: 'chat:mention',
  reply: 'chat:reply',
  dm: 'chat:dm',
  invite: 'chat:invite',
  poll: 'chat:poll',
} as const;
