/** Errors thrown by the Kafka event bus adapter and connector bridge. */

// ---------------------------------------------------------------------------
// Adapter errors
// ---------------------------------------------------------------------------

export class KafkaAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaAdapterError';
  }
}

export class KafkaAdapterConfigError extends KafkaAdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaAdapterConfigError';
  }
}

export class KafkaDurableSubscriptionNameRequiredError extends KafkaAdapterError {
  constructor() {
    super('[KafkaAdapter] durable subscriptions require a name. Pass opts.name.');
    this.name = 'KafkaDurableSubscriptionNameRequiredError';
  }
}

export class KafkaDuplicateDurableSubscriptionError extends KafkaAdapterError {
  constructor(event: string, name: string) {
    super(
      `[KafkaAdapter] a durable subscription named "${name}" for event "${event}" already exists.`,
    );
    this.name = 'KafkaDuplicateDurableSubscriptionError';
  }
}

export class KafkaDurableSubscriptionOffError extends KafkaAdapterError {
  constructor() {
    super(
      '[KafkaAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all consumers.',
    );
    this.name = 'KafkaDurableSubscriptionOffError';
  }
}

// ---------------------------------------------------------------------------
// Connector errors
// ---------------------------------------------------------------------------

export class KafkaConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaConnectorError';
  }
}

export class KafkaConnectorValidationError extends KafkaConnectorError {
  readonly zodError: unknown;

  constructor(message: string, zodError: unknown) {
    super(message);
    this.name = 'KafkaConnectorValidationError';
    this.zodError = zodError;
  }
}

export class KafkaConnectorMessageIdError extends KafkaConnectorError {
  constructor(event: string) {
    super(
      `[KafkaConnectors] outbound event "${event}" has no messageId, no eventId, and onIdMissing='reject'.`,
    );
    this.name = 'KafkaConnectorMessageIdError';
  }
}

export class KafkaDuplicateConnectorError extends KafkaConnectorError {
  constructor(key: string) {
    super(`[slingshot-kafka-connectors] duplicate connector: ${key}`);
    this.name = 'KafkaDuplicateConnectorError';
  }
}

export class KafkaConnectorStateError extends KafkaConnectorError {
  constructor(operation: string, state: string) {
    super(
      `[KafkaConnectors] ${operation}() called in state "${state}"; only valid from a compatible state.`,
    );
    this.name = 'KafkaConnectorStateError';
  }
}
