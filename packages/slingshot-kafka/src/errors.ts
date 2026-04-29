/** Errors thrown by the Kafka event bus adapter and connector bridge. */

// ---------------------------------------------------------------------------
// Adapter errors
// ---------------------------------------------------------------------------

/** Base error for Kafka event bus adapter failures. */
export class KafkaAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaAdapterError';
  }
}

/** Raised when Kafka adapter configuration is invalid or incomplete. */
export class KafkaAdapterConfigError extends KafkaAdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaAdapterConfigError';
  }
}

/** Raised when a durable Kafka subscription is registered without a required name. */
export class KafkaDurableSubscriptionNameRequiredError extends KafkaAdapterError {
  constructor() {
    super('[KafkaAdapter] durable subscriptions require a name. Pass opts.name.');
    this.name = 'KafkaDurableSubscriptionNameRequiredError';
  }
}

/** Raised when a Kafka durable subscription name is reused for the same event. */
export class KafkaDuplicateDurableSubscriptionError extends KafkaAdapterError {
  constructor(event: string, name: string) {
    super(
      `[KafkaAdapter] a durable subscription named "${name}" for event "${event}" already exists.`,
    );
    this.name = 'KafkaDuplicateDurableSubscriptionError';
  }
}

/** Raised when code tries to unregister a durable Kafka subscription with off(). */
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

/** Base error for Kafka connector bridge failures. */
export class KafkaConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaConnectorError';
  }
}

/** Raised when a Kafka connector definition fails schema validation. */
export class KafkaConnectorValidationError extends KafkaConnectorError {
  readonly zodError: unknown;

  constructor(message: string, zodError: unknown) {
    super(message);
    this.name = 'KafkaConnectorValidationError';
    this.zodError = zodError;
  }
}

/** Raised when an outbound connector event cannot be assigned a Kafka message ID. */
export class KafkaConnectorMessageIdError extends KafkaConnectorError {
  constructor(event: string) {
    super(
      `[KafkaConnectors] outbound event "${event}" has no messageId, no eventId, and onIdMissing='reject'.`,
    );
    this.name = 'KafkaConnectorMessageIdError';
  }
}

/** Raised when two Kafka connectors are registered with the same key. */
export class KafkaDuplicateConnectorError extends KafkaConnectorError {
  constructor(key: string) {
    super(`[slingshot-kafka-connectors] duplicate connector: ${key}`);
    this.name = 'KafkaDuplicateConnectorError';
  }
}

/** Raised when a Kafka connector lifecycle method is called from an invalid state. */
export class KafkaConnectorStateError extends KafkaConnectorError {
  constructor(operation: string, state: string) {
    const validStateHint =
      operation === 'start'
        ? 'only valid from "idle" or "stopped"; finish or stop the previous run first'
        : operation === 'stop'
          ? 'only valid from "running"'
          : 'only valid from a compatible state';

    super(`[KafkaConnectors] ${operation}() called in state "${state}"; ${validStateHint}.`);
    this.name = 'KafkaConnectorStateError';
  }
}
