import { SlingshotError } from '@lastshotlabs/slingshot-core';

/** Base class for transactional event delivery failures. */
export class TransactionalEventError extends SlingshotError {}

/** Thrown when outbox delivery is requested but reliability is not available. */
export class TransactionalEventDeliveryUnavailableError extends TransactionalEventError {
  override readonly name = 'TransactionalEventDeliveryUnavailableError';
  constructor(message = 'Transactional event delivery is not configured for this app.') {
    super('TRANSACTIONAL_EVENT_DELIVERY_UNAVAILABLE', message);
  }
}

/** Thrown when outbox delivery omits its transaction scope. */
export class TransactionalEventScopeRequiredError extends TransactionalEventError {
  override readonly name = 'TransactionalEventScopeRequiredError';
  constructor() {
    super(
      'TRANSACTIONAL_EVENT_SCOPE_REQUIRED',
      "Event delivery 'outbox' requires an open framework transaction scope.",
    );
  }
}

/** Thrown when reliability and transaction scopes select different SQL stores. */
export class TransactionalEventStoreMismatchError extends TransactionalEventError {
  override readonly name = 'TransactionalEventStoreMismatchError';
  constructor(
    readonly configuredStore: string,
    readonly scopeStore: string,
  ) {
    super(
      'TRANSACTIONAL_EVENT_STORE_MISMATCH',
      `Event reliability store '${configuredStore}' does not match scope store '${scopeStore}'.`,
    );
  }
}

/** Thrown when a governed envelope cannot be safely serialized for persistence. */
export class TransactionalEventSerializationError extends TransactionalEventError {
  override readonly name = 'TransactionalEventSerializationError';
  constructor(message: string, cause?: Error) {
    super('TRANSACTIONAL_EVENT_SERIALIZATION_FAILED', message, cause);
  }
}

/** Thrown when event reliability configuration selects an unsupported topology. */
export class EventReliabilityTopologyError extends TransactionalEventError {
  override readonly name = 'EventReliabilityTopologyError';
  constructor(message: string) {
    super('EVENT_RELIABILITY_TOPOLOGY_INVALID', message);
  }
}
