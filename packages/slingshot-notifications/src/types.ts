import type {
  DeliveryAdapter,
  NotificationCreatedEventPayload,
  NotificationPriority,
  NotificationRecord,
  NotifyInput,
  NotifyManyInput,
  PaginatedResult,
  ResolvedPreference,
} from '@lastshotlabs/slingshot-core';

export type NotificationPreferenceScope = 'global' | 'source' | 'type';

export interface NotificationPreferenceRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId?: string | null;
  readonly scope: NotificationPreferenceScope;
  readonly source?: string | null;
  readonly type?: string | null;
  readonly muted: boolean;
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly inAppEnabled: boolean;
  readonly quietStart?: string | null;
  readonly quietEnd?: string | null;
  readonly updatedAt: Date | string;
}

export interface NotificationPreferenceDefaults {
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly inAppEnabled: boolean;
}

export interface NotificationAdapter {
  create(input: Record<string, unknown>): Promise<NotificationRecord>;
  getById(id: string): Promise<NotificationRecord | null>;
  update(id: string, input: Record<string, unknown>): Promise<NotificationRecord | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<NotificationRecord>>;
  clear(): Promise<void>;
  listByUser(params: { userId: string }): Promise<PaginatedResult<NotificationRecord>>;
  listUnread(params: { userId: string }): Promise<PaginatedResult<NotificationRecord>>;
  markRead(params: { id: string; userId: string }): Promise<NotificationRecord | null>;
  markAllRead(params: { userId: string }): Promise<{ count: number } | number>;
  unreadCount(params: { userId: string }): Promise<{ count: number }>;
  unreadCountBySource(params: { userId: string; source: string }): Promise<{ count: number }>;
  unreadCountByScope(params: {
    userId: string;
    source: string;
    scopeId: string;
  }): Promise<{ count: number }>;
  hasUnreadByDedupKey(params: { userId: string; dedupKey: string }): Promise<boolean>;
  findByDedupKey(params: { userId: string; dedupKey: string }): Promise<NotificationRecord | null>;
  /**
   * Atomic dedup-or-create.
   *
   * If an UNREAD notification already exists for `(userId, dedupKey)`, atomically
   * increments its `data.count` field by 1 and returns the updated record with
   * `created: false`. Otherwise inserts a new notification using the supplied
   * `create` input and returns it with `created: true`.
   *
   * **Atomicity contract** — this operation MUST be safe to call concurrently
   * with the same `(userId, dedupKey)` from multiple callers without producing
   * duplicate notifications. Implementations should use database-level upsert
   * primitives (`INSERT ... ON CONFLICT DO NOTHING`, transactional CAS, etc.)
   * rather than non-atomic find-then-update sequences.
   *
   * Implementations without dedup support (for example, ephemeral test
   * adapters) MAY fall back to a non-atomic implementation, but production
   * adapters MUST honor the atomicity contract.
   *
   * @param params.userId - Owner of the notification.
   * @param params.dedupKey - Stable dedup key.
   * @param params.create - Full create input used when no existing record matches.
   * @returns The resulting record together with whether a new row was inserted.
   */
  dedupOrCreate(params: {
    userId: string;
    dedupKey: string;
    create: Record<string, unknown>;
  }): Promise<{ record: NotificationRecord; created: boolean }>;
  listPendingDispatch(params: {
    limit: number;
    now: Date;
    signal?: AbortSignal;
  }): Promise<NotificationRecord[]>;
  markDispatched(params: { id: string; dispatchedAt: Date }): Promise<void>;
}

export interface NotificationPreferenceAdapter {
  create(input: Record<string, unknown>): Promise<NotificationPreferenceRecord>;
  getById(id: string): Promise<NotificationPreferenceRecord | null>;
  update(id: string, input: Record<string, unknown>): Promise<NotificationPreferenceRecord | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<NotificationPreferenceRecord>>;
  clear(): Promise<void>;
  listByUser(params: { userId: string }): Promise<PaginatedResult<NotificationPreferenceRecord>>;
  resolveForNotification(params: { userId: string }): Promise<NotificationPreferenceRecord[]>;
}

export type {
  DeliveryAdapter,
  NotificationCreatedEventPayload,
  NotificationPriority,
  NotificationRecord,
  NotifyInput,
  NotifyManyInput,
  ResolvedPreference,
};
