/** Receipt inserted before one transactional consumer handler executes. */
export interface NewInboxReceipt {
  readonly consumerName: string;
  readonly eventId: string;
  readonly eventKey: string;
  readonly processedAt: string;
  readonly occurredAt: string;
}

/** Transaction-bound inbox deduplication persistence contract. */
export interface InboxRepository {
  /**
   * Insert a receipt if it has not already committed.
   *
   * Returns true only for the delivery that owns handler execution.
   */
  insert(receipt: NewInboxReceipt): boolean | Promise<boolean>;
}
