import type { EventReliabilityConfig } from '@lastshotlabs/slingshot-events';

/** Top-level governed-event configuration. */
export interface EventsConfig {
  /**
   * Optional transactional outbox/inbox reliability. Omit to preserve immediate
   * event delivery without migrations, workers, or additional topology.
   */
  readonly reliability?: EventReliabilityConfig;
}
