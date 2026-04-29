/** Errors thrown by the push notification plugin. */

export { FcmTokenError } from './providers/fcm';

/**
 * Thrown when the APNS provider encounters a delivery failure that cannot be
 * attributed to a subscription-level issue (invalidToken, payloadTooLarge).
 */
export class ApnsDeliveryError extends Error {
  readonly code = 'APNS_DELIVERY_ERROR' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApnsDeliveryError';
  }
}

/**
 * Thrown when the Web Push provider encounters a delivery failure that cannot be
 * attributed to a subscription-level issue (invalidToken, payloadTooLarge).
 */
export class WebPushDeliveryError extends Error {
  readonly code = 'WEB_PUSH_DELIVERY_ERROR' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebPushDeliveryError';
  }
}

/**
 * Thrown when the push router encounters a routing-level failure (e.g., circuit
 * breaker open, all providers unreachable, invalid router state).
 */
export class PushRouterError extends Error {
  readonly code = 'PUSH_ROUTER_ERROR' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PushRouterError';
  }
}

/**
 * Thrown when a topic fan-out operation fails due to a routing-level issue
 * (e.g., topic resolution failure, membership enumeration error).
 */
export class PushTopicFanoutError extends Error {
  readonly code = 'PUSH_TOPIC_FANOUT_ERROR' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PushTopicFanoutError';
  }
}
