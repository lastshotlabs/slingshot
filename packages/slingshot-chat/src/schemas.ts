// packages/slingshot-chat/src/schemas.ts
/**
 * Zod validation schemas for chat HTTP request bodies.
 *
 * These are the PUBLIC API shapes — a deliberate subset of the entity field
 * definitions. Stored here rather than inlined in routes so that multiple
 * routes can share them and they remain easy to audit.
 */
import { z } from 'zod';
import {
  MAX_CONTENT_ATTACHMENTS,
  MAX_CONTENT_BODY_LENGTH,
  MAX_CONTENT_MENTIONS,
  assetRefSchema,
  contactDataSchema,
  locationDataSchema,
  quotePreviewSchema,
  systemEventDataSchema,
} from '@lastshotlabs/slingshot-core';

// ─── Room ─────────────────────────────────────────────────────────────────────

/** Body for `POST /rooms` — create a group or broadcast room. */
export const createRoomSchema = z.object({
  name: z.string().min(1).max(255).nullable(),
  type: z.enum(['group', 'broadcast']),
  encrypted: z.boolean().optional().default(false),
  retentionDays: z.number().int().positive().nullable().optional(),
  description: z.string().max(1024).nullable().optional(),
  topic: z.string().max(256).nullable().optional(),
});

/** Body for `PATCH /rooms/:roomId` — update a room. */
export const updateRoomSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  description: z.string().max(1024).nullable().optional(),
  topic: z.string().max(256).nullable().optional(),
  avatarUrl: z.url().nullable().optional(),
});

// ─── RoomMember ───────────────────────────────────────────────────────────────

/** Body for `POST /rooms/:roomId/members` — add a member. */
export const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'member']).optional().default('member'),
});

/** Body for `PATCH /rooms/:roomId/members/:targetUserId` — update a membership. */
export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  nickname: z.string().max(64).nullable().optional(),
  notifyOn: z.enum(['all', 'mentions', 'none']).optional(),
  mutedUntil: z.iso.datetime().nullable().optional(),
});

// ─── Message ──────────────────────────────────────────────────────────────────

/** Body for `POST /messages` — send a message. */
export const createMessageSchema = z.object({
  roomId: z.string().min(1),
  body: z.string().min(1).max(MAX_CONTENT_BODY_LENGTH),
  type: z
    .enum(['text', 'image', 'file', 'gif', 'sticker', 'voice', 'location', 'contact', 'system'])
    .optional()
    .default('text'),
  format: z.enum(['plain', 'markdown']).optional().default('markdown'),
  replyToId: z.uuid().nullable().optional().default(null),
  mentions: z.array(z.string().min(1)).max(MAX_CONTENT_MENTIONS).optional(),
  broadcastMentions: z
    .array(z.enum(['everyone', 'here']))
    .max(2)
    .optional(),
  mentionedRoleIds: z.array(z.string().min(1)).max(MAX_CONTENT_MENTIONS).optional(),
  attachments: z.array(assetRefSchema).max(MAX_CONTENT_ATTACHMENTS).optional(),
  quotedMessageId: z.uuid().optional(),
  quotePreview: quotePreviewSchema.optional(),
  pollId: z.string().min(1).optional(),
  stickerId: z.string().min(1).optional(),
  location: locationDataSchema.optional(),
  contact: contactDataSchema.optional(),
  systemEvent: systemEventDataSchema.optional(),
  appMetadata: z.record(z.string(), z.unknown()).nullable().optional().default(null),
  scheduledAt: z.iso.datetime().optional(),
});

/** Body for `PATCH /messages/:messageId` — edit a message body. */
export const updateMessageSchema = z.object({
  body: z.string().min(1).max(MAX_CONTENT_BODY_LENGTH),
});

/** Body for `POST /messages/forward` — forward a message to another room. */
export const forwardMessageSchema = z.object({
  messageId: z.string().min(1),
  targetRoomId: z.string().min(1),
});

// ─── MessageReaction ──────────────────────────────────────────────────────────

/** Body for `POST /messages/:messageId/reactions` — add a reaction. */
export const addReactionSchema = z.object({
  emoji: z.string().min(1).max(64),
});

// ─── Block ────────────────────────────────────────────────────────────────────

/** Body for `POST /management/blocks` — block a user. */
export const blockBodySchema = z.object({
  targetUserId: z.string().min(1),
});

// ─── FavoriteRoom ─────────────────────────────────────────────────────────────

/** Body for `POST /management/favorites` — favorite a room. */
export const favoriteBodySchema = z.object({
  roomId: z.string().min(1),
});

/** Body for `PATCH /management/favorites/:roomId/order` — reorder a favorite. */
export const orderBodySchema = z.object({
  sortOrder: z.number().int().nonnegative(),
});

// ─── Pin ──────────────────────────────────────────────────────────────────────

// ─── RoomInvite ──────────────────────────────────────────────────────────────

/** Body for `POST /room-invites` — create an invite link. */
export const createInviteSchema = z.object({
  roomId: z.string().min(1),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

/** Body for `POST /room-invites/redeem` — redeem an invite token. */
export const redeemInviteSchema = z.object({
  token: z.string().min(1),
});

// ─── Reminder ────────────────────────────────────────────────────────────────

/** Body for `POST /reminders` — create a reminder. */
export const createReminderSchema = z.object({
  roomId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  triggerAt: z.iso.datetime(),
});

// ─── Pin ──────────────────────────────────────────────────────────────────────

/** Body for `POST /management/pins/:roomId` — pin a message. */
export const pinBodySchema = z.object({
  messageId: z.string().min(1),
});
