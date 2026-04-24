import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import {
  createListSortedMemoryHandler,
  createListSortedMongoHandler,
  createListSortedPostgresHandler,
  createListSortedRedisHandler,
  createListSortedSqliteHandler,
} from '../operations/listByContainerSorted';
import {
  createSearchInContainerMemoryHandler,
  createSearchInContainerMongoHandler,
  createSearchInContainerPostgresHandler,
  createSearchInContainerRedisHandler,
  createSearchInContainerSqliteHandler,
} from '../operations/searchInContainer';

/**
 * Entity definition for a community thread (topic post).
 *
 * Exported as `ThreadEntity` from the package index. Threads are searchable
 * (`syncMode: 'write-through'`) — the search plugin indexes them automatically
 * on every create/update.
 *
 * @remarks
 * Key operations:
 * - `publish`: draft → published state transition; sets `publishedAt`.
 * - `lock` / `unlock`: toggle the `locked` flag (prevents new replies).
 * - `pin` / `unpin`: toggle the `pinned` flag.
 * - `listByContainer`: paginated lookup by container.
 * - `search`: full-text search on `title` and `body`.
 *
 * Cascade: when `auth:user.deleted` fires, all threads by that user are
 * soft-deleted (status → `'deleted'`, `deletedBy` set).
 */
export const Thread = defineEntity('Thread', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string(),
    authorId: field.string(),
    title: field.string(),
    body: field.string({ optional: true }),
    format: field.enum(['plain', 'markdown'] as const, { default: 'markdown' }),
    status: field.enum(['draft', 'published', 'deleted'] as const, { default: 'draft' }),
    pinned: field.boolean({ default: false }),
    locked: field.boolean({ default: false }),
    score: field.number({ default: 0 }),
    reactionSummary: field.json({ default: '{"upvotes":0,"downvotes":0,"emojis":{}}' }),
    mentions: field.json({ optional: true }),
    broadcastMentions: field.json({ optional: true }),
    mentionedRoleIds: field.json({ optional: true }),
    attachments: field.json({ optional: true }),
    embeds: field.json({ optional: true }),
    pollId: field.string({ optional: true, immutable: true }),
    stickerId: field.string({ optional: true, immutable: true }),
    location: field.json({ optional: true }),
    contact: field.json({ optional: true }),
    components: field.json({ optional: true }),
    /** Number of replies to this thread (denormalized). */
    replyCount: field.integer({ default: 0 }),
    /** Most recent activity timestamp (reply or edit). */
    lastActivityAt: field.date({ optional: true }),
    /** Author ID of the most recent reply. */
    lastReplyById: field.string({ optional: true }),
    /** Timestamp of the most recent reply. */
    lastReplyAt: field.date({ optional: true }),
    /** View count (rate-limited per user). */
    viewCount: field.integer({ default: 0 }),
    /** Reply ID marked as the accepted solution (Q&A). */
    solutionReplyId: field.string({ optional: true }),
    /** When the solution was marked. */
    solutionMarkedAt: field.date({ optional: true }),
    /** Denormalized tag IDs for search filtering. */
    tagIds: field.json({ optional: true }),
    publishedAt: field.date({ optional: true }),
    deletedBy: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['containerId', 'createdAt'], { direction: 'desc' }),
    index(['containerId', 'status']),
    index(['containerId', 'lastActivityAt'], { direction: 'desc' }),
    index(['containerId', 'score'], { direction: 'desc' }),
    index(['authorId']),
  ],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  search: {
    fields: {
      title: { searchable: true, weight: 3 },
      body: { searchable: true, weight: 1 },
      status: { filterable: true },
      containerId: { filterable: true },
      authorId: { filterable: true },
      pinned: { filterable: true, sortable: true },
      locked: { filterable: true },
      score: { sortable: true },
      replyCount: { sortable: true },
      lastActivityAt: { sortable: true },
      viewCount: { sortable: true },
      createdAt: { sortable: true },
      publishedAt: { sortable: true },
      tagIds: { filterable: true },
      solutionReplyId: { filterable: true },
    },
    syncMode: 'write-through',
  },
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'authorId', from: 'ctx:actor.id' },

    get: { auth: 'none' },
    list: { auth: 'none' },

    create: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
      },
      event: {
        key: 'community:thread.created',
        payload: ['id', 'tenantId', 'containerId', 'authorId', 'title', 'format'],
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
        'banCheck',
        'autoMod',
        'threadPostCreate',
      ],
    },
    update: {
      permission: {
        requires: 'community:container.write',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      event: {
        key: 'community:thread.updated',
        payload: ['id', 'tenantId', 'containerId'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },
    delete: {
      permission: {
        requires: 'community:container.delete-content',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
      event: {
        key: 'community:thread.deleted',
        payload: ['id', 'tenantId', 'containerId'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },

    operations: {
      publish: {
        permission: {
          requires: 'community:container.write',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.published',
          payload: ['id', 'tenantId', 'containerId', 'authorId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            userId: 'record:authorId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      lock: {
        permission: {
          requires: 'community:container.lock',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.locked',
          payload: ['id', 'tenantId', 'containerId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      unlock: {
        permission: {
          requires: 'community:container.lock',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.unlocked',
          payload: ['id', 'tenantId', 'containerId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      pin: {
        permission: {
          requires: 'community:container.pin',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.pinned',
          payload: ['id', 'tenantId', 'containerId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      unpin: {
        permission: {
          requires: 'community:container.pin',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.unpinned',
          payload: ['id', 'tenantId', 'containerId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      search: { auth: 'none' },
      listByContainer: { auth: 'none' },
      searchInContainer: { auth: 'none' },
      listByContainerSorted: { auth: 'none' },
      updateComponents: { auth: 'userAuth' },
      markAsSolution: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.write',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.solved',
          payload: ['id', 'tenantId', 'containerId', 'solutionReplyId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      unmarkAsSolution: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.write',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
        event: {
          key: 'community:thread.unsolved',
          payload: ['id', 'tenantId', 'containerId'],
          exposure: ['client-safe', 'tenant-webhook'],
          scope: {
            tenantId: 'record:tenantId',
            actorId: 'ctx:actorId',
            resourceType: 'community:container',
            resourceId: 'record:containerId',
          },
        },
      },
      incrementView: { auth: 'none' },
    },
    permissions: {
      resourceType: 'community:container',
      scopeField: 'containerId',
      actions: [
        'read',
        'write',
        'delete',
        'manage-owners',
        'manage-moderators',
        'manage-members',
        'pin',
        'lock',
        'delete-content',
        'review-report',
        'apply-ban',
        'lift-ban',
      ],
      roles: {
        owner: ['*'],
        moderator: ['pin', 'lock', 'delete-content', 'review-report', 'apply-ban', 'lift-ban'],
        'report-reviewer': ['review-report'],
        'community-admin': ['*'],
      },
    },

    middleware: {
      pollRequiredGuard: true,
      attachmentRequiredGuard: true,
      banCheck: true,
      autoMod: true,
      threadPostCreate: true,
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
 * Custom operations for the Thread entity.
 *
 * - `publish`: draft → published state transition.
 * - `lock` / `unlock`: toggle the locked flag.
 * - `pin` / `unpin`: toggle the pinned flag.
 * - `listByContainer`: paginated lookup filtered by `containerId`.
 * - `search`: full-text search on title and body within a container.
 * - `searchInContainer`: multi-filter search with `q`, `tag`, `authorId`, and
 *   `status` query params. Route: `GET container/:containerId/threads/search`.
 * - `listByContainerSorted`: sorted thread listing with sort preset and optional
 *   time-window filter. Route: `GET container/:containerId/threads`.
 */
export const threadOperations = defineOperations(Thread, {
  publish: op.transition({
    field: 'status',
    from: 'draft',
    to: 'published',
    match: { id: 'param:id' },
    set: { publishedAt: 'now' },
    returns: 'entity',
  }),

  lock: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['locked'],
  }),
  unlock: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['locked'],
  }),
  pin: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['pinned'],
  }),
  unpin: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['pinned'],
  }),

  listByContainer: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'many',
  }),

  search: op.search({
    fields: ['title', 'body'],
    filter: { containerId: 'param:containerId' },
    paginate: true,
  }),

  updateComponents: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['components'],
  }),

  /** Atomically increment `replyCount` on a thread. */
  incrementReplyCount: op.increment({
    field: 'replyCount',
    by: 1,
    match: { id: 'param:id' },
  }),

  /** Atomically decrement `replyCount` on a thread. */
  decrementReplyCount: op.increment({
    field: 'replyCount',
    by: -1,
    match: { id: 'param:id' },
  }),

  /** Update denormalized last-activity fields. */
  updateLastActivity: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['lastActivityAt', 'lastReplyById', 'lastReplyAt'],
  }),

  /** Atomically increment view count. */
  incrementView: op.increment({
    field: 'viewCount',
    by: 1,
    match: { id: 'param:id' },
  }),

  /** Mark a reply as the accepted solution (Q&A). */
  markAsSolution: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['solutionReplyId', 'solutionMarkedAt'],
  }),

  /** Unmark the accepted solution. */
  unmarkAsSolution: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['solutionReplyId', 'solutionMarkedAt'],
  }),

  /** Attach resolved link-preview embeds to a thread. Internal-only. */
  attachEmbeds: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['embeds'],
  }),

  /**
   * Search threads within a container with optional filters.
   *
   * Route: `GET container/:containerId/threads/search`
   *
   * Query params: `q` (full-text), `tag` (tagId), `authorId`, `status`,
   * `limit`, `cursor`.
   *
   * The memory backend performs in-memory substring matching. Production
   * backends should delegate to the slingshot-search plugin.
   */
  searchInContainer: op.custom({
    http: { method: 'get', path: 'container/:containerId/threads/search' },
    memory: store => createSearchInContainerMemoryHandler(store),
    sqlite: db => createSearchInContainerSqliteHandler(db),
    postgres: pool => createSearchInContainerPostgresHandler(pool),
    mongo: collection => createSearchInContainerMongoHandler(collection),
    redis: redis => createSearchInContainerRedisHandler(redis),
  }),

  /**
   * List threads in a container with a sort preset and optional time-window.
   *
   * Route: `GET container/:containerId/threads`
   *
   * Query params:
   * - `sort`: `new` | `active` | `hot` | `top` | `controversial` (default: `new`)
   * - `window`: `24h` | `7d` | `30d` | `all` (default: `all`; applies to `top`
   *   and `controversial` only)
   * - `limit`, `cursor`: pagination.
   */
  listByContainerSorted: op.custom({
    http: { method: 'get', path: 'container/:containerId/threads' },
    memory: store => createListSortedMemoryHandler(store),
    sqlite: db => createListSortedSqliteHandler(db),
    postgres: pool => createListSortedPostgresHandler(pool),
    mongo: collection => createListSortedMongoHandler(collection),
    redis: redis => createListSortedRedisHandler(redis),
  }),
});
