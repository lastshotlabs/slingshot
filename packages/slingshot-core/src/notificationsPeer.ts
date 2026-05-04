/**
 * Shared notification record / adapter / builder types used across packages.
 *
 * These types form the typed surface that `slingshot-notifications` publishes through
 * its `Notifications` package contract (`@lastshotlabs/slingshot-notifications/public.ts`).
 * Cross-package consumers resolve the contract handles via `ctx.capabilities.require(...)`
 * — the legacy `NOTIFICATIONS_PLUGIN_STATE_KEY` peer-state publish has been removed.
 */

/** Notification priority persisted by the notifications plugin. */
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Normalized notification record shape shared across packages.
 *
 * This is the neutral contract feature plugins use for formatter registration,
 * delivery adapters, and source-scoped notification creation.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId?: string | null;
  readonly source: string;
  readonly type: string;
  readonly actorId?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly dedupKey?: string | null;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly read: boolean;
  readonly readAt?: Date | string | null;
  readonly deliverAt?: Date | string | null;
  readonly dispatched: boolean;
  readonly dispatchedAt?: Date | string | null;
  readonly scopeId?: string | null;
  readonly priority: NotificationPriority;
  readonly createdAt: Date | string;
}

/** Effective delivery preferences resolved for one notification dispatch. */
export interface ResolvedPreference {
  readonly muted: boolean;
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly inAppEnabled: boolean;
  readonly quietStart?: string | null;
  readonly quietEnd?: string | null;
}

/** Event payload delivered to notification delivery adapters. */
export interface NotificationCreatedEventPayload {
  readonly notification: NotificationRecord;
  readonly preferences: ResolvedPreference;
}

/** Delivery adapter contract registered with `slingshot-notifications`. */
export interface DeliveryAdapter {
  deliver(event: NotificationCreatedEventPayload): Promise<void>;
}

/** Input accepted by a source-scoped notification builder. */
export interface NotifyInput {
  readonly userId: string;
  readonly tenantId?: string;
  readonly type: string;
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly scopeId?: string;
  readonly dedupKey?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly priority?: NotificationPriority;
  readonly deliverAt?: Date;
  readonly allowSelfNotify?: boolean;
}

/** Batch notification input accepted by a source-scoped builder. */
export interface NotifyManyInput extends Omit<NotifyInput, 'userId'> {
  readonly userIds: readonly string[];
}

/** Builder contract published by `slingshot-notifications` to peer plugins. */
export interface NotificationBuilder {
  notify(input: NotifyInput): Promise<NotificationRecord | null>;
  notifyMany(input: NotifyManyInput): Promise<NotificationRecord[]>;
  schedule(input: NotifyInput & { deliverAt: Date }): Promise<NotificationRecord>;
  cancel(notificationId: string): Promise<void>;
}
