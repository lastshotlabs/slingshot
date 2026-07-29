import type { EventEnvelope } from '@lastshotlabs/slingshot-core';

/** Immutable outbox row inserted with a domain transaction. */
export interface NewOutboxRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventKey: string;
  readonly envelopeJson: string;
  readonly createdAt: string;
}

/** Transaction-bound persistence contract for new outbox rows. */
export interface OutboxRepository {
  /** Insert exactly one governed envelope; duplicate event IDs reject. */
  insert(row: NewOutboxRow): void | Promise<void>;
}

/** Durable row leased by one dispatcher instance. */
export interface LeasedOutboxRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventKey: string;
  readonly envelopeJson: string;
  readonly attempts: number;
}

/** Persistence operations used by the outbox dispatcher outside domain transactions. */
export interface OutboxDispatchRepository {
  claim(input: {
    readonly owner: string;
    readonly limit: number;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<readonly LeasedOutboxRow[]>;
  markDelivered(input: {
    readonly id: string;
    readonly owner: string;
    readonly deliveredAt: string;
  }): Promise<boolean>;
  release(input: {
    readonly id: string;
    readonly owner: string;
    readonly attempts: number;
    readonly availableAt: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly dead: boolean;
  }): Promise<boolean>;
  releaseOwner(owner: string, now: string): Promise<number>;
}

/** Persisted lifecycle state exposed to operators. */
export type OutboxStatus = 'pending' | 'leased' | 'delivered' | 'dead';

/** Bounded operational view of one outbox row. */
export interface OutboxOperationalRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventKey: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly lastErrorCode: string | null;
}

/** Aggregate state used by readiness, metrics, and `events outbox status`. */
export interface OutboxOperationalStatus {
  readonly counts: Readonly<Record<OutboxStatus, number>>;
  readonly oldestPendingAt: string | null;
  readonly expiredLeases: number;
}

/** Audit record written whenever an operator makes dead work retryable. */
export interface OutboxReplayAudit {
  readonly id: string;
  readonly eventId: string | null;
  readonly replayedCount: number;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** Read-only and explicitly mutating outbox/inbox operator contract. */
export interface EventReliabilityOperations {
  status(now: string): Promise<OutboxOperationalStatus>;
  list(status: OutboxStatus, limit: number): Promise<readonly OutboxOperationalRow[]>;
  retryEvent(input: {
    readonly eventId: string;
    readonly now: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<boolean>;
  retryAllDead(input: {
    readonly now: string;
    readonly actor: string;
    readonly reason: string;
    readonly limit: number;
  }): Promise<number>;
  purgeDelivered(before: string, limit: number): Promise<number>;
  purgeInbox(before: string, limit: number): Promise<number>;
}

/** Serialize a governed envelope without changing its stable identity. */
export function serializeOutboxEnvelope(envelope: EventEnvelope): NewOutboxRow {
  const createdAt = new Date().toISOString();
  return {
    id: globalThis.crypto.randomUUID(),
    eventId: envelope.meta.eventId,
    eventKey: envelope.key,
    envelopeJson: JSON.stringify(envelope),
    createdAt,
  };
}
