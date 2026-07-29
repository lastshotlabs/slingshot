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
