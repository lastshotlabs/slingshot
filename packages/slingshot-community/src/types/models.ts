import type {
  AssetRef,
  ContentFormat,
  EmbedData,
  PaginationOptions,
  QuotePreview,
} from '@lastshotlabs/slingshot-core';

/**
 * Lifecycle status of a thread.
 *
 * - `'draft'`: created but not yet visible to other users.
 * - `'published'`: visible to members; set via the `publish` operation.
 * - `'deleted'`: soft-deleted; hidden from lists but retained for audit.
 */
export type ThreadStatus = 'draft' | 'published' | 'deleted';
/**
 * Lifecycle status of a reply.
 *
 * - `'published'`: visible to members.
 * - `'deleted'`: soft-deleted; hidden but retained for audit.
 */
export type ReplyStatus = 'published' | 'deleted';
/**
 * Type of reaction a user can attach to a thread or reply.
 *
 * - `'upvote'` / `'downvote'`: counted in `reactionSummary` and contribute to `score`.
 * - `'emoji'`: freeform emoji reactions tracked in `reactionSummary.emojis`.
 */
export type ReactionType = 'upvote' | 'downvote' | 'emoji';
/**
 * Role a user holds within a container (community space).
 *
 * - `'member'`: standard read/write access.
 * - `'moderator'`: can pin/lock threads, delete content, review reports, and apply bans.
 * - `'owner'`: full permissions including managing moderators and other owners.
 */
export type ContainerMemberRole = 'member' | 'moderator' | 'owner';
/**
 * The kind of content or account that was reported.
 *
 * - `'thread'`: a thread post was reported.
 * - `'reply'`: a reply was reported.
 * - `'user'`: a user account was reported.
 */
export type ReportTargetType = 'thread' | 'reply' | 'user';
/**
 * Workflow status of a content report.
 *
 * - `'pending'`: awaiting review.
 * - `'resolved'`: a moderator took action (e.g. removed the content).
 * - `'dismissed'`: the report was reviewed and no action was taken.
 */
export type ReportStatus = 'pending' | 'resolved' | 'dismissed';
/**
 * Aggregate reaction counts for a thread or reply.
 *
 * Materialised by the `updateScore` aggregate operation whenever a reaction is
 * added or removed. Stored as a JSON column on Thread and Reply.
 */
export interface ReactionSummary {
  /** Total upvote reactions. */
  upvotes: number;
  /** Total downvote reactions. */
  downvotes: number;
  /** Emoji reactions keyed by the emoji character; value is the count. */
  emojis: Record<string, number>;
}

/**
 * A community space that groups threads together (analogous to a subreddit,
 * channel, or forum category).
 *
 * Containers use soft-delete (`deletedAt`). Deleted containers are excluded
 * from list results unless `includeDeleted: true` is passed.
 *
 * @remarks
 * **Relationships:** owns `Thread[]`, `ContainerMember[]`, `ContainerRule[]`,
 * `Report[]`, and `Ban[]` records scoped to its ID. Deleting a container does
 * not automatically cascade-delete child records — children should be cleaned
 * up separately or filtered by checking the container's `deletedAt` timestamp.
 *
 * **Operations (community plugin):** `list`, `getById`, `create`, `update`,
 * `delete` (soft), `getBySlug` (lookup by `slug`), and `search`.
 *
 * **Permission gates:** create requires `community:container.write`; update
 * and delete require `community:container.manage` or container `owner` role.
 */
export interface Container {
  id: string;
  /** Optional tenant scope for multi-tenant deployments. */
  tenantId?: string;
  /** URL-safe identifier, unique within the tenant. */
  slug: string;
  /** Display name. */
  name: string;
  /** Optional description shown to members. */
  description?: string;
  /** User ID of the creator. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the container is soft-deleted. */
  deletedAt?: string;
}

/**
 * A post (topic) within a container.
 *
 * Threads start as `'draft'` and become visible after the `publish` transition
 * operation. `score` is derived from `reactionSummary` via the `updateScore`
 * aggregate and updated automatically on every reaction change.
 *
 * @remarks
 * **Relationships:** belongs to one `Container` via `containerId`. Owns
 * `Reply[]` records scoped to its ID. Owns `Reaction[]` records where
 * `targetType === 'thread'`. Soft-deletes (via `status: 'deleted'`) rather than
 * removing rows.
 *
 * **Operations (community plugin):** `list`, `getById`, `create`, `update`,
 * `delete` (status transition to `'deleted'`), `publish` (transition to
 * `'published'`), `pin` / `unpin` (fieldUpdate on `pinned`), `lock` / `unlock`
 * (fieldUpdate on `locked`), `updateScore` (computedAggregate), and `search`.
 *
 * **Cascades:** deleting a thread does not cascade to replies or reactions;
 * replies are excluded by the `status !== 'deleted'` guard on thread lookup.
 *
 * **Permission gates:** create requires authentication; delete/pin/lock require
 * the caller to be the author, a container moderator, or container owner.
 */
export interface Thread {
  id: string;
  tenantId?: string;
  /** The container this thread belongs to. */
  containerId: string;
  /** User ID of the author. */
  authorId: string;
  title: string;
  /** Optional rich/markdown body content. */
  body?: string;
  /** Content format: `'plain'` or `'markdown'` (default). */
  format: ContentFormat;
  status: ThreadStatus;
  /** When `true`, the thread is pinned to the top of the container list. */
  pinned: boolean;
  /** When `true`, no new replies can be created. */
  locked: boolean;
  /** Derived score: `upvotes - downvotes`. Updated automatically. */
  score: number;
  reactionSummary: ReactionSummary;
  /** Explicit user-ID mentions parsed from body or provided by client. */
  mentions?: readonly string[];
  /** Broadcast mention tokens (`'everyone'` or `'here'`). */
  broadcastMentions?: readonly ('everyone' | 'here')[];
  /** Role IDs mentioned via `<@&roleId>` tokens. */
  mentionedRoleIds?: readonly string[];
  /** File/media attachments. */
  attachments?: readonly AssetRef[];
  /** Resolved link-preview embeds. */
  embeds?: readonly EmbedData[];
  /** Poll entity ID when a poll is attached to this thread. */
  pollId?: string;
  components?: unknown;
  /** Set when the thread transitions from `'draft'` to `'published'`. */
  publishedAt?: string;
  /** User ID of the moderator or user who deleted the thread. */
  deletedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user reply within a thread.
 *
 * Replies support threaded (nested) display via `parentId` and `depth`. The
 * `score` field is updated automatically via the `updateScore` aggregate
 * operation whenever a reaction is added or removed.
 *
 * @remarks
 * **Relationships:** belongs to one `Thread` via `threadId`. May have a parent
 * `Reply` via `parentId` (top-level replies have no `parentId`). Owns
 * `Reaction[]` records where `targetType === 'reply'`. Soft-deletes via
 * `status: 'deleted'`.
 *
 * **Operations (community plugin):** `list`, `getById`, `create`, `update`,
 * `delete` (status transition to `'deleted'`), `updateScore`
 * (computedAggregate), and `search`.
 *
 * **Guards:** creation is blocked by the `threadStateGuard` middleware if the
 * parent thread is not `'published'` or is `locked`. Ban check middleware also
 * blocks creation if the author has an active container-scoped or global ban.
 *
 * **Permission gates:** create requires authentication; delete requires the
 * caller to be the author, a container moderator, or container owner.
 */
export interface Reply {
  id: string;
  tenantId?: string;
  /** Thread this reply belongs to. */
  threadId: string;
  /** Container this reply belongs to. */
  containerId: string;
  /** Parent reply ID for nested/threaded replies. `undefined` = top-level reply. */
  parentId?: string;
  /** User ID of the author. */
  authorId: string;
  body: string;
  /** Content format: `'plain'` or `'markdown'` (default). */
  format: ContentFormat;
  status: ReplyStatus;
  /** Derived score: `upvotes - downvotes`. Updated automatically. */
  score: number;
  reactionSummary: ReactionSummary;
  /** Explicit user-ID mentions parsed from body or provided by client. */
  mentions?: readonly string[];
  /** Broadcast mention tokens (`'everyone'` or `'here'`). */
  broadcastMentions?: readonly ('everyone' | 'here')[];
  /** Role IDs mentioned via `<@&roleId>` tokens. */
  mentionedRoleIds?: readonly string[];
  /** File/media attachments. */
  attachments?: readonly AssetRef[];
  /** Resolved link-preview embeds. */
  embeds?: readonly EmbedData[];
  /** ID of the reply being quoted. */
  quotedReplyId?: string;
  /** Snapshot of the quoted reply content. */
  quotePreview?: QuotePreview;
  components?: unknown;
  /** Nesting depth (0 = top-level). Used to limit recursion in tree renders. */
  depth: number;
  /** User ID of the person who deleted the reply. */
  deletedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single user reaction on a thread or reply.
 *
 * Each (targetId, targetType, userId) tuple is unique — reacting twice
 * replaces the previous reaction. The `updateScore` aggregate operation
 * on the Reaction entity automatically updates the target's `score` and
 * `reactionSummary` fields.
 *
 * @remarks
 * **Relationships:** belongs to either a `Thread` or `Reply` via `targetId` /
 * `targetType`. Each user may have at most one reaction per target (enforced
 * by the upsert operation on the entity).
 *
 * **Operations (community plugin):** `upsert` (add or change reaction),
 * `remove` (delete reaction), `list` (by targetId + targetType).
 *
 * **Side effects:** every upsert or remove calls the `updateScore`
 * computedAggregate operation on the parent Thread or Reply to refresh
 * `score` and `reactionSummary`. This is performed in an `afterHook`
 * registered during `setupPost`.
 */
export interface Reaction {
  id: string;
  tenantId?: string;
  /** ID of the thread or reply being reacted to. */
  targetId: string;
  targetType: 'thread' | 'reply';
  /** User who reacted. */
  userId: string;
  type: ReactionType;
  /** For `'emoji'` reactions: the specific emoji character (e.g. `'👍'`). */
  value?: string;
  createdAt: string;
}

/**
 * Membership record linking a user to a container.
 *
 * The (containerId, userId) pair is unique. Use the `assignRole` operation
 * to change a member's role without deleting and re-creating the record.
 *
 * @remarks
 * **Relationships:** belongs to one `Container` via `containerId`. Represents
 * a single user's membership and role within that container.
 *
 * **Operations (community plugin):** `list` (by containerId), `join` (create
 * member with `role: 'member'`), `leave` (delete), `assignRole` (fieldUpdate
 * on `role`). The `assignRole` operation triggers the `grantManager`
 * after-middleware, which creates or revokes the corresponding
 * `'community:container'` permission grant for `moderator` and `owner` roles.
 *
 * **Permission gates:** join requires authentication; assignRole requires the
 * `community:container.manage-members` permission or container owner role.
 */
export interface ContainerMember {
  id: string;
  tenantId?: string;
  containerId: string;
  userId: string;
  role: ContainerMemberRole;
  /** Timestamp when the user joined the container. */
  joinedAt: string;
}

/**
 * A community rule displayed to members of a container.
 *
 * Rules are shown in ascending `order`. Update the `order` field to
 * re-sort without deleting records.
 *
 * @remarks
 * **Relationships:** belongs to one `Container` via `containerId`.
 *
 * **Operations (community plugin):** `list` (by containerId), `create`,
 * `update` (title, description, order), `delete`.
 *
 * **Permission gates:** create, update, and delete require the
 * `community:container.manage` permission or container owner role.
 */
export interface ContainerRule {
  id: string;
  tenantId?: string;
  containerId: string;
  /** Short title, e.g. "Be respectful". */
  title: string;
  /** Optional extended explanation of the rule. */
  description?: string;
  /** Sort order (ascending). Default 0. */
  order: number;
  createdAt: string;
}

/**
 * A user-submitted report about a piece of content or a user account.
 *
 * Reports start as `'pending'`. Moderators transition them to `'resolved'`
 * or `'dismissed'` via the `resolve` and `dismiss` operations, which require
 * the `community:container.review-report` permission.
 *
 * @remarks
 * **Relationships:** references a `Thread`, `Reply`, or user by `targetId` /
 * `targetType`. There is no foreign-key constraint — the referenced content
 * may be soft-deleted at the time the report is reviewed.
 *
 * **Operations (community plugin):** `list` (moderator-only, by status /
 * containerId), `create` (any authenticated user), `resolve` (transition to
 * `'resolved'` + fieldUpdate on `resolvedBy` / `resolvedAction`), `dismiss`
 * (transition to `'dismissed'`).
 *
 * **Auto-moderation:** the `autoMod` middleware may create reports with
 * `reporterId: 'system:automod'` automatically when content is flagged.
 *
 * **Permission gates:** list, resolve, and dismiss require
 * `community:container.review-report` or container moderator/owner role.
 */
export interface Report {
  id: string;
  tenantId?: string;
  /** Container scope for thread/reply reports. User reports may be platform scoped. */
  containerId?: string;
  /** ID of the reported thread, reply, or user. */
  targetId: string;
  targetType: ReportTargetType;
  /** User who submitted the report. */
  reporterId: string;
  /** Free-text reason provided by the reporter. */
  reason: string;
  status: ReportStatus;
  /** User ID of the moderator who acted on the report. */
  resolvedBy?: string;
  /** Description of the action taken (e.g. "removed content"). */
  resolvedAction?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A ban restricting a user from creating content.
 *
 * When `containerId` is present the ban applies to a single container.
 * When absent it is a global (platform-wide) ban. The `banCheck` middleware
 * enforces active bans on thread and reply creation routes.
 *
 * Bans are lifted by the `removeBan` operation (not by deletion), which sets
 * `unbannedBy` and `unbannedAt`.
 *
 * @remarks
 * **Relationships:** scoped to a `Container` via `containerId` (optional) and
 * references a user via `userId`.
 *
 * **Operations (community plugin):** `list` (moderator-only, by userId /
 * containerId), `create` (issues a new ban), `removeBan` (fieldUpdate setting
 * `unbannedBy` + `unbannedAt`; does not delete the record).
 *
 * **Side effects:** creating a ban triggers the `banNotify` after-middleware,
 * which creates a shared notification via `slingshot-notifications`.
 *
 * **Expiry:** bans with `expiresAt` in the past are considered inactive. The
 * `banCheck` middleware checks `expiresAt > now` before blocking content
 * creation.
 *
 * **Permission gates:** create and removeBan require
 * `community:container.manage-bans` or container moderator/owner role.
 */
export interface Ban {
  id: string;
  tenantId?: string;
  /** The banned user's ID. */
  userId: string;
  /** Container scope. When absent, the ban is global. */
  containerId?: string;
  /** Moderator or admin who issued the ban. */
  bannedBy: string;
  reason: string;
  /** Expiry timestamp. When absent the ban is permanent until manually lifted. */
  expiresAt?: string;
  createdAt: string;
  /** User ID of the moderator who lifted the ban. */
  unbannedBy?: string;
  /** Timestamp when the ban was lifted. */
  unbannedAt?: string;
}

/**
 * Options for paginating through containers.
 *
 * Passed to the Container entity adapter's list operation. Extends
 * `PaginationOptions` with community-specific filters.
 *
 * @example
 * ```ts
 * import type { ListContainersOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: ListContainersOptions = {
 *   tenantId: 'tenant-1',
 *   limit: 20,
 *   cursor: lastCursor,
 * };
 * ```
 */
export interface ListContainersOptions extends PaginationOptions {
  /** Filter to a specific tenant. */
  tenantId?: string;
  /** Include soft-deleted containers in the result. Default: false. */
  includeDeleted?: boolean;
}

/**
 * Options for paginating and filtering threads within a container.
 *
 * @example
 * ```ts
 * import type { ListThreadsOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: ListThreadsOptions = {
 *   status: 'published',
 *   sortBy: 'score',
 *   sortDir: 'desc',
 *   limit: 10,
 * };
 * ```
 */
export interface ListThreadsOptions extends PaginationOptions {
  tenantId?: string;
  /** Filter by thread lifecycle status. */
  status?: ThreadStatus;
  /** Filter pinned threads only. */
  pinned?: boolean;
  /** Filter locked threads only. */
  locked?: boolean;
  /** Filter threads by a specific author. */
  authorId?: string;
  /** Field to sort by. Default: `'createdAt'`. */
  sortBy?: 'createdAt' | 'score' | 'publishedAt';
  sortDir?: 'asc' | 'desc';
}

/**
 * Options for fetching replies for a thread.
 *
 * @example
 * ```ts
 * import type { GetRepliesOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: GetRepliesOptions = {
 *   view: 'tree',
 *   sortBy: 'score',
 *   sortDir: 'desc',
 *   limit: 50,
 * };
 * ```
 */
export interface GetRepliesOptions extends PaginationOptions {
  /** `'flat'`: ordered list; `'tree'`: nested by `parentId`. Default: `'flat'`. */
  view?: 'flat' | 'tree';
  /** Filter replies by a specific author. */
  authorId?: string;
  sortBy?: 'createdAt' | 'score';
  sortDir?: 'asc' | 'desc';
}

/**
 * Options for paginating and filtering content reports.
 *
 * Requires the `community:container.review-report` permission to use.
 *
 * @example
 * ```ts
 * import type { ListReportsOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: ListReportsOptions = {
 *   status: 'pending',
 *   containerId: 'container-abc',
 *   limit: 20,
 * };
 * ```
 */
export interface ListReportsOptions extends PaginationOptions {
  tenantId?: string;
  /** Limit to reports from a specific container. */
  containerId?: string;
  /** Filter by report workflow status. */
  status?: ReportStatus;
  /** Filter by the type of content that was reported. */
  targetType?: ReportTargetType;
}

/**
 * Options for paginating and filtering active bans.
 *
 * @example
 * ```ts
 * import type { ListBansOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: ListBansOptions = {
 *   containerId: 'container-abc',
 *   includeExpired: false,
 * };
 * ```
 */
export interface ListBansOptions extends PaginationOptions {
  tenantId?: string;
  /** Limit to bans scoped to a specific container. */
  containerId?: string;
  /** Include expired bans in the result set. Default: false. */
  includeExpired?: boolean;
}

/**
 * Options for full-text search within the community.
 *
 * Passed to the `search` custom operation on Thread and Reply entities.
 * Full-text search is powered by the slingshot-search plugin when configured;
 * falls back to DB-native LIKE queries otherwise.
 *
 * @example
 * ```ts
 * import type { SearchOptions } from '@lastshotlabs/slingshot-community';
 *
 * const opts: SearchOptions = {
 *   containerId: 'container-abc',
 *   limit: 10,
 * };
 * ```
 */
export interface SearchOptions extends PaginationOptions {
  tenantId?: string;
  /** Limit search results to a specific container. */
  containerId?: string;
}
