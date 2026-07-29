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
