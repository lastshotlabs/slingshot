/**
 * Webhook domain events — module augmentation for `SlingshotEventMap`.
 *
 * The webhooks plugin emits operational events for delivery lifecycle
 * and queue health. These events are server-side only and used for ops
 * alerting / retry reconciliation.
 *
 * **Event summary:**
 * | Event key | When emitted |
 * |---|---|
 * | `webhook:timeoutClamped` | Delivery timeout exceeds the system maximum and is clamped |
 * | `webhook:enqueueFailed` | Delivery could not be enqueued (queue reject or connection loss) |
 */

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    /**
     * Emitted when a delivery's requested timeout exceeds the system
     * maximum and is clamped to {@link TIMEOUT_CLAMP_MS}. Operators should
     * investigate the endpoint configuration to ensure the requested
     * timeout is intentional.
     */
    'webhook:timeoutClamped': {
      deliveryId: string;
      endpointId: string;
      requestedTimeoutMs: number;
      clampedTimeoutMs: number;
    };

    /**
     * Emitted when a delivery could not be enqueued — the queue rejected
     * the job or the connection was lost. The delivery remains in `pending`
     * status so a sweep can re-enqueue it. Operators should monitor this
     * event for persistent queue connectivity issues.
     */
    'webhook:enqueueFailed': {
      deliveryId: string;
      endpointId: string;
      event: string;
      eventId: string;
      error: string;
    };
  }
}

export {};
