// packages/slingshot-chat/src/entities/message.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a chat message.
 *
 * Messages are the core content unit within a room. Soft-deleted messages
 * retain their row with `deletedAt` set and an empty `body`.
 *
 * @remarks
 * Key operations:
 * - `listByRoom`: Cursor-paginated list of messages in a room (newest-first).
 * - `softDelete`: Set `deletedAt` and blank `body` (message content preserved in
 *   audit log but hidden in UI).
 * - `incrementDelivered`: Increment `deliveredTo` counter on WS delivery confirmation.
 * - `incrementReadBy`: Increment `readBy` counter when a read receipt is recorded.
 */
export const Message = defineEntity('Message', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string({ immutable: true }),
    authorId: field.string({ optional: true, immutable: true }),
    body: field.string(),
    type: field.enum(
      [
        'text',
        'image',
        'file',
        'gif',
        'sticker',
        'voice',
        'location',
        'contact',
        'system',
      ] as const,
      { default: 'text', immutable: true },
    ),
    format: field.enum(['plain', 'markdown'] as const, { default: 'markdown' }),
    replyToId: field.string({ optional: true, immutable: true }),
    editedAt: field.date({ optional: true }),
    deletedAt: field.date({ optional: true }),
    mentions: field.json({ optional: true }),
    broadcastMentions: field.json({ optional: true }),
    mentionedRoleIds: field.json({ optional: true }),
    attachments: field.json({ optional: true }),
    embeds: field.json({ optional: true }),
    quotedMessageId: field.string({ optional: true, immutable: true }),
    quotePreview: field.json({ optional: true }),
    pollId: field.string({ optional: true, immutable: true }),
    stickerId: field.string({ optional: true, immutable: true }),
    location: field.json({ optional: true }),
    contact: field.json({ optional: true }),
    systemEvent: field.json({ optional: true }),
    appMetadata: field.json({ optional: true }),
    components: field.json({ optional: true }),
    /** Number of direct replies to this message (denormalized for display). */
    replyCount: field.integer({ default: 0 }),
    /** ID of the original message when this message is a forward. */
    forwardedFromId: field.string({ optional: true, immutable: true }),
    /** When set, the message is scheduled for future delivery. */
    scheduledAt: field.date({ optional: true }),
    /** Whether a scheduled message has been delivered. */
    scheduledDelivered: field.boolean({ default: false }),
    /**
     * Denormalized author display name, snapshotted at create time.
     * Used by push/notification formatters without cross-package lookup.
     */
    authorName: field.string({ optional: true, immutable: true }),
    deliveredTo: field.integer({ default: 0 }),
    readBy: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['roomId', 'createdAt'], { direction: 'desc' }),
    index(['authorId']),
    index(['roomId', 'deletedAt']),
    index(['replyToId']),
    index(['scheduledAt', 'scheduledDelivered']),
  ],
  search: {
    fields: {
      body: { searchable: true, weight: 10 },
      roomId: { searchable: false, filterable: true },
      authorId: { searchable: false, filterable: true },
      type: { searchable: false, filterable: true },
      createdAt: { searchable: false, sortable: true },
    },
    syncMode: 'event-bus',
  },
  softDelete: { field: 'deletedAt', strategy: 'non-null' },
  routes: {
    defaults: { auth: 'userAuth' },
    disable: [
      'incrementDelivered',
      'incrementReadBy',
      'incrementReplyCount',
      'decrementReplyCount',
      'updateComponents',
      'attachEmbeds',
      'claimDueScheduledMessages',
    ],
    dataScope: { field: 'authorId', from: 'ctx:actor.id' },
    get: {
      permission: {
        requires: 'chat:room.read',
        scope: { resourceType: 'chat:room', resourceId: 'record:roomId' },
      },
    },
    list: {},
    create: {
      permission: {
        requires: 'chat:room.write',
        scope: { resourceType: 'chat:room', resourceId: 'body:roomId' },
      },
      event: {
        key: 'chat:message.created',
        payload: ['id', 'roomId', 'authorId', 'type', 'body'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:authorId',
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
      middleware: [
        'archiveGuard',
        'pollRequiredGuard',
        'attachmentRequiredGuard',
        'broadcastGuard',
        'replyCountUpdate',
        'messagePostCreate',
        'messageNotify',
      ],
    },
    update: {
      permission: {
        requires: 'chat:message.edit',
        scope: { resourceType: 'chat:message', resourceId: 'param:id' },
      },
      event: {
        key: 'chat:message.updated',
        payload: ['id', 'roomId'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
    },
    delete: {
      permission: {
        requires: 'chat:message.delete',
        scope: { resourceType: 'chat:message', resourceId: 'param:id' },
      },
      event: {
        key: 'chat:message.deleted',
        payload: ['id', 'roomId', 'deletedAt'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'chat:room',
          resourceId: 'record:roomId',
        },
      },
      middleware: ['replyCountDecrement'],
    },
    operations: {
      listByRoom: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.read',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
      listReplies: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.read',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
      searchMessages: {
        auth: 'userAuth',
        permission: {
          requires: 'chat:room.read',
          scope: { resourceType: 'chat:room', resourceId: 'param:roomId' },
        },
      },
      forwardMessage: {
        auth: 'userAuth',
        path: 'forward',
        permission: {
          requires: 'chat:room.write',
          scope: { resourceType: 'chat:room', resourceId: 'body:targetRoomId' },
        },
      },
      incrementDelivered: { auth: 'userAuth' },
      incrementReadBy: { auth: 'userAuth' },
      incrementReplyCount: { auth: 'userAuth' },
      decrementReplyCount: { auth: 'userAuth' },
      updateComponents: { auth: 'userAuth' },
      attachEmbeds: { auth: 'userAuth' },
      claimDueScheduledMessages: { auth: 'userAuth' },
    },
    middleware: {
      archiveGuard: true,
      broadcastGuard: true,
      pollRequiredGuard: true,
      attachmentRequiredGuard: true,
      messagePostCreate: true,
      messageNotify: true,
      replyCountUpdate: true,
      replyCountDecrement: true,
    },
    permissions: {
      resourceType: 'chat:message',
      scopeField: 'roomId',
      actions: ['read', 'write', 'edit', 'delete'],
      roles: {
        owner: ['*'],
        author: ['read', 'write', 'edit', 'delete'],
        member: ['read', 'write'],
      },
    },
  },
});

/**
 * Custom operations for the Message entity.
 *
 * - `listByRoom`: Paginated messages in a room, ordered by `createdAt`.
 * - `listReplies`: Paginated replies to a message within a room.
 * - `incrementDelivered`: Increment `deliveredTo` counter.
 * - `incrementReadBy`: Increment `readBy` counter.
 * - `incrementReplyCount`: Atomically increment `replyCount` on a parent message.
 * - `decrementReplyCount`: Atomically decrement `replyCount` on a parent message.
 * - `forwardMessage`: Forward a message to another room.
 * - `searchMessages`: Full-text search within a room.
 */
export const messageOperations = defineOperations(Message, {
  listByRoom: op.lookup({
    fields: { roomId: 'param:roomId' },
    returns: 'many',
  }),

  /** Paginated replies to a message within a room. */
  listReplies: op.lookup({
    fields: {
      replyToId: 'param:messageId',
      roomId: 'param:roomId',
    },
    returns: 'many',
  }),

  /**
   * Forward a message to another room. Creates a new message in the
   * target room with `forwardedFromId` referencing the original.
   * Handler is wired by the chat plugin's `messageBuildAdapter`.
   */
  forwardMessage: op.custom({
    http: { method: 'post', path: 'forward' },
  }),

  /** Database-level full-text search within a room. */
  searchMessages: op.search({
    fields: ['body'],
    filter: { roomId: 'param:roomId' },
    paginate: true,
  }),

  /** Atomically increment `replyCount` on a parent message. */
  incrementReplyCount: op.increment({
    field: 'replyCount',
    by: 1,
    match: { id: 'param:id' },
  }),

  /** Atomically decrement `replyCount` on a parent message. */
  decrementReplyCount: op.increment({
    field: 'replyCount',
    by: -1,
    match: { id: 'param:id' },
  }),

  incrementDelivered: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['deliveredTo'],
  }),

  incrementReadBy: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['readBy'],
  }),

  updateComponents: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['components'],
  }),

  /** Attach resolved link-preview embeds to a message. Internal-only. */
  attachEmbeds: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['embeds'],
  }),

  /** Internal: atomic batch claim of due scheduled messages. No HTTP route. */
  claimDueScheduledMessages: op.custom({}),
});
