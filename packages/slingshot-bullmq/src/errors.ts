/** Errors thrown by the BullMQ event bus adapter. */

export class BullMQAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BullMQAdapterError';
  }
}

export class DurableSubscriptionNameRequiredError extends BullMQAdapterError {
  constructor() {
    super('[BullMQAdapter] durable subscriptions require a name. Pass opts.name.');
    this.name = 'DurableSubscriptionNameRequiredError';
  }
}

export class DuplicateDurableSubscriptionError extends BullMQAdapterError {
  constructor(event: string, name: string) {
    super(
      `[BullMQAdapter] a durable subscription named "${name}" for event "${event}" already exists. Names must be unique per event.`,
    );
    this.name = 'DuplicateDurableSubscriptionError';
  }
}

export class DurableSubscriptionOffError extends BullMQAdapterError {
  constructor() {
    super(
      '[BullMQAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all workers.',
    );
    this.name = 'DurableSubscriptionOffError';
  }
}
