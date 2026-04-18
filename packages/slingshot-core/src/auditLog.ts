/**
 * A single audit log entry recording an HTTP request or admin action.
 *
 * Stored by `AuditLogProvider.logEntry()` and queryable via `AuditLogProvider.getLogs()`.
 * The audit middleware creates entries automatically for authenticated requests.
 */
export interface AuditLogEntry {
  /** Unique entry identifier. */
  id: string;
  /** Authenticated user ID, or `null` for unauthenticated requests. */
  userId: string | null;
  /** Session ID, or `null` for M2M/unauthenticated requests. */
  sessionId: string | null;
  /** Tenant ID scope, or `null` for global or unauthenticated requests. */
  tenantId: string | null;
  /** HTTP method (e.g. `'POST'`). */
  method: string;
  /** Request path (e.g. `'/api/users/usr_123'`). */
  path: string;
  /** HTTP response status code. */
  status: number;
  /** Client IP address, or `null` if not determinable. */
  ip: string | null;
  /** User-Agent header value, or `null` if absent. */
  userAgent: string | null;
  /**
   * Application-level action name (e.g. `'user.login'`, `'post.delete'`).
   *
   * @remarks
   * Set when the audit middleware or a route handler explicitly names the action via
   * `auditLog.setAction(c, 'user.login')`. `undefined` on entries created automatically
   * by the HTTP audit middleware without action annotation (raw HTTP entries).
   */
  action?: string;
  /**
   * The resource type acted upon (e.g. `'user'`, `'post'`, `'tenant'`).
   *
   * @remarks
   * Set together with `resourceId` when auditing operations on a specific entity.
   * `undefined` on unannotated HTTP audit entries or actions that are not resource-scoped.
   */
  resource?: string;
  /**
   * The specific resource ID acted upon (e.g. a user ID, post ID).
   *
   * @remarks
   * Only meaningful when `resource` is also set. `undefined` on unannotated entries or
   * collection-level actions where no single resource ID applies.
   */
  resourceId?: string;
  /** Additional contextual metadata for the action. */
  meta?: Record<string, unknown>;
  /** The `x-request-id` value for correlation with logs. */
  requestId?: string;
  /** ISO 8601 timestamp when the entry was created. */
  createdAt: string;
  /**
   * MongoDB TTL expiry date — set when `auditLogTtlDays` is configured.
   *
   * @remarks
   * When present, MongoDB's TTL index on the `expiresAt` field automatically deletes
   * the document once this date is reached (typically within 60 seconds of expiry).
   * `undefined` when no TTL is configured — entries persist indefinitely.
   * Only applicable to the MongoDB-backed audit log adapter; SQL adapters use a
   * `createdAt`-based cleanup job instead.
   */
  expiresAt?: Date;
}

/**
 * Filters for querying the audit log.
 * All fields are optional and combined with AND semantics.
 *
 * @remarks
 * Multiple filter fields are ANDed together — only entries matching ALL specified filters
 * are returned. There is no OR or NOT support at the query level. To query across
 * disjoint criteria (e.g., entries for user A OR user B), issue two separate queries and
 * merge the results in application code.
 */
export interface AuditLogQuery {
  /** Filter by user ID. */
  userId?: string;
  /** Filter by tenant ID. */
  tenantId?: string;
  /** Filter by request path (exact match). */
  path?: string;
  /** Filter by HTTP method. */
  method?: string;
  /** Return entries created after this date. */
  after?: Date | string;
  /** Return entries created before this date. */
  before?: Date | string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Opaque pagination cursor from a previous response. */
  cursor?: string;
}

/**
 * Storage and query contract for the audit log.
 *
 * Implemented by backing store adapters (memory, SQLite, Mongo, Postgres).
 * Registered via `ResolvedPersistence.auditLog` and called by the audit middleware.
 */
export interface AuditLogProvider {
  /**
   * Write a single audit log entry to the backing store.
   * Called by the audit middleware after each request completes.
   *
   * @remarks
   * The audit middleware calls `logEntry()` in a fire-and-forget pattern — it does NOT
   * `await` the result in the request/response path. This means logging failures do not
   * cause request errors, but it also means an entry may not be durable when the
   * response has already been sent. Implementations should handle errors internally
   * (e.g., log to stderr) rather than throwing, since the caller does not `await` the
   * promise.
   */
  logEntry(entry: AuditLogEntry): Promise<void>;
  /**
   * Query stored audit log entries.
   * @param query - Filter and pagination options.
   * @returns A page of entries sorted in reverse-chronological order (newest first),
   *   with `nextCursor` set to an opaque pagination token when more results exist.
   *   Pass `nextCursor` as `query.cursor` in the next call to get the following page.
   *   `nextCursor` is `undefined` (not an empty string) when the last page has been reached.
   */
  getLogs(query: AuditLogQuery): Promise<{ items: AuditLogEntry[]; nextCursor?: string }>;
}
