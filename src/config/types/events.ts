import type { EventReliabilityConfig } from '@lastshotlabs/slingshot-events';

/** Authenticated framework event-operator HTTP surface. */
export interface EventOperatorConfig {
  readonly enabled: true;
  /** Route prefix. Defaults to `/admin/events`. */
  readonly path?: string;
}

/** Top-level governed-event configuration. */
export interface EventsConfig {
  /**
   * Optional transactional outbox/inbox reliability. Omit to preserve immediate
   * event delivery without migrations, workers, or additional topology.
   */
  readonly reliability?: EventReliabilityConfig;
  /** Mount authenticated, permission-checked event inspection and mutation routes. */
  readonly operator?: EventOperatorConfig;
}
