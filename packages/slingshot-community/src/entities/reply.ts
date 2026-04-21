import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a reply within a thread.
 *
 * Exported as `ReplyEntity` from the package index. Replies are searchable
 * (`syncMode: 'write-through'`).
 *
 * @remarks
 * Reply creation is gated by `threadStateGuard` (blocks replies to locked or
 * deleted threads), `banCheck` (blocks banned users), and `autoMod`.
 *
 * Cascade: when `auth:user.deleted` fires, all replies by that user are
 * soft-deleted.
 */
export const Reply = defineEntity('Reply', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    threadId: field.string(),
    containerId: field.string(),
    parentId: field.string({ optional: true }),
    authorId: field.string(),
    body: field.string(),
    format: field.enum(['plain', 'markdown'] as const, { default: 'markdown' }),
    status: field.enum(['published', 'deleted'] as const, { default: 'published' }),
    score: field.number({ default: 0 }),
    reactionSummary: field.json({ default: '{"upvotes":0,"downvotes":0,"emojis":{}}' }),
    mentions: field.json({ optional: true }),
    broadcastMentions: field.json({ optional: true }),
    mentionedRoleIds: field.json({ optional: true }),
    attachments: field.json({ optional: true }),
    embeds: field.json({ optional: true }),
    stickerId: field.string({ optional: true, immutable: true }),
    location: field.json({ optional: true }),
    contact: field.json({ optional: true }),
    quotedReplyId: field.string({ optional: true, immutable: true }),
    quotePreview: field.json({ optional: true }),
    components: field.json({ optional: true }),
    /** Whether this reply is marked as the accepted solution. */
    isSolution: field.boolean({ default: false }),
    depth: field.integer({ default: 0 }),
    deletedBy: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['threadId', 'createdAt'], { direction: 'desc' }),
    index(['containerId', 'createdAt'], { direction: 'desc' }),
    index(['authorId']),
  ],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  search: {
    fields: {
      body: { searchable: true },
      threadId: { filterable: true },
      containerId: { filterable: true },
      authorId: { filterable: true },
      status: { filterable: true },
      score: { sortable: true },
      createdAt: { sortable: true },
    },
    syncMode: 'write-through',
  },
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'authorId', from: 'ctx:authUserId' },

    get: { auth: 'none' },
    list: { auth: 'none' },

    create: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      event: {
        key: 'community:reply.created',
        payload: ['id', 'tenantId', 'threadId', 'containerId', 'parentId', 'authorId'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          userId: 'record:authorId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
      middleware: [
        'pollRequiredGuard',
        'attachmentRequiredGuard',
        'threadStateGuard',
        'banCheck',
        'autoMod',
        'replyPostCreate',
        'replyCountUpdate',
      ],
    },
    update: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.delete-content',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      event: {
        key: 'community:reply.deleted',
        payload: ['id', 'tenantId', 'threadId', 'containerId'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
      middleware: ['replyCountDecrement'],
    },

    operations: {
      search: { auth: 'none' },
      listByThread: { auth: 'none' },
      updateComponents: { auth: 'userAuth' },
    },
    middleware: {
      pollRequiredGuard: true,
      attachmentRequiredGuard: true,
      threadStateGuard: true,
      banCheck: true,
      autoMod: true,
      replyPostCreate: true,
      replyCountUpdate: true,
      replyCountDecrement: true,
    },

    cascades: [
      {
        event: 'auth:user.deleted',
        batch: {
          action: 'update',
          filter: { authorId: 'param:userId' },
          set: { status: 'deleted', deletedBy: 'param:userId' },
        },
      },
    ],
  },
});

/**
 * Custom operations for the Reply entity.
 *
 * - `listByThread`: paginated lookup filtered by `threadId`.
 * - `search`: full-text search on `body` within a thread.
 */
export const replyOperations = defineOperations(Reply, {
  listByThread: op.lookup({
    fields: { threadId: 'param:threadId' },
    returns: 'many',
  }),

  search: op.search({
    fields: ['body'],
    filter: { threadId: 'param:threadId' },
    paginate: true,
  }),

  updateComponents: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['components'],
  }),

  /** Attach resolved link-preview embeds to a reply. Internal-only. */
  attachEmbeds: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['embeds'],
  }),
});
