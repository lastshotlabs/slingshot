/** Errors thrown by the BullMQ event bus adapter. */

export class BullMQAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BullMQAdapterError';
  }
}

/** Raised when a durable BullMQ subscription is registered without a required name. */
export class DurableSubscriptionNameRequiredError extends BullMQAdapterError {
  constructor() {
    super('[BullMQAdapter] durable subscriptions require a name. Pass opts.name.');
    this.name = 'DurableSubscriptionNameRequiredError';
  }
}

/** Raised when a BullMQ durable subscription name is reused for the same event. */
export class DuplicateDurableSubscriptionError extends BullMQAdapterError {
  constructor(event: string, name: string) {
    super(
      `[BullMQAdapter] a durable subscription named "${name}" for event "${event}" already exists. Names must be unique per event.`,
    );
    this.name = 'DuplicateDurableSubscriptionError';
  }
}

/** Raised when code tries to unregister a durable BullMQ subscription with off(). */
export class DurableSubscriptionOffError extends BullMQAdapterError {
  constructor() {
    super(
      '[BullMQAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all workers.',
    );
    this.name = 'DurableSubscriptionOffError';
  }
}
