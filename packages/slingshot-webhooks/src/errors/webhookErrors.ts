import { SlingshotError } from '@lastshotlabs/slingshot-core';

/** Thrown when a webhook URL fails validation (invalid format, private IP, etc.). */
export class WebhookUrlValidationError extends SlingshotError {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super('WEBHOOK_URL_INVALID', `Invalid webhook URL: ${reason}`);
    this.name = 'WebhookUrlValidationError';
    this.url = url;
    this.reason = reason;
  }
}

/** Thrown when webhook runtime adapters or hooks are missing or misconfigured. */
export class WebhookRuntimeError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_RUNTIME_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookRuntimeError';
  }
}

/** Thrown when webhook plugin configuration is invalid. */
export class WebhookConfigError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_CONFIG_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookConfigError';
  }
}

/** Thrown on pagination cursor errors (missing cursor, repeated cursor). */
export class WebhookPaginationError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_PAGINATION_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookPaginationError';
  }
}

/** Thrown for queue lifecycle state violations (e.g. enqueue before start). */
export class WebhookStateError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_STATE_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookStateError';
  }
}

/** Thrown when secret encryption/decryption fails. */
export class WebhookCipherError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_CIPHER_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookCipherError';
  }
}

/** Thrown for invalid inbound webhook provider configuration. */
export class WebhookInboundConfigError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_INBOUND_CONFIG_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookInboundConfigError';
  }
}

/** Thrown when a webhook delivery status transition is invalid. */
export class WebhookDeliveryTransitionError extends SlingshotError {
  constructor(message: string) {
    super('WEBHOOK_DELIVERY_TRANSITION_ERROR', `[slingshot-webhooks] ${message}`);
    this.name = 'WebhookDeliveryTransitionError';
  }
}
