import {
  incrementCounter,
  observeHistogram,
  registerGaugeCallback,
} from '@framework/metrics/registry';
import type { MetricsState } from '@framework/metrics/registry';
import type {
  AcknowledgedEventBus,
  HealthIndicator,
  HealthReport,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import type {
  EventReliabilityConfig,
  EventReliabilityOperations,
  InboxLifecycleEvent,
  OutboxLifecycleEvent,
} from '@lastshotlabs/slingshot-events';
import {
  createPostgresEventReliabilityOperations,
  createSqliteEventReliabilityOperations,
} from '@lastshotlabs/slingshot-events';

interface CachedHealthBus {
  getHealth?: () => HealthReport;
  health?: () => { status?: string; state?: string; connected?: boolean };
}

function transportHealthy(bus: AcknowledgedEventBus): boolean {
  const candidate = bus as AcknowledgedEventBus & CachedHealthBus;
  if (candidate.getHealth) return candidate.getHealth().state !== 'unhealthy';
  if (candidate.health) {
    const report = candidate.health();
    if (report.connected === false) return false;
    return report.status !== 'unhealthy' && report.state !== 'unhealthy';
  }
  return true;
}

/** Bind store operations without opening another connection or transaction abstraction. */
export function createFrameworkEventReliabilityOperations(
  infra: StoreInfra,
  config: EventReliabilityConfig,
): EventReliabilityOperations {
  return config.store === 'postgres'
    ? createPostgresEventReliabilityOperations(infra.getPostgres())
    : createSqliteEventReliabilityOperations(infra.getSqliteDb());
}

/** Create critical/warning readiness indicators from cached transport and bounded SQL queries. */
export function createEventReliabilityIndicators(
  operations: EventReliabilityOperations,
  bus: AcknowledgedEventBus,
  config: EventReliabilityConfig,
  now: () => Date = () => new Date(),
): readonly HealthIndicator[] {
  const maxPendingAgeMs = config.readiness?.maxPendingAgeMs ?? 60_000;
  const deadSeverity = config.readiness?.deadRows ?? 'critical';
  const snapshot = () => operations.status(now().toISOString());
  return [
    {
      name: 'event-reliability-critical',
      severity: 'critical',
      async check() {
        const status = await snapshot();
        const deadCritical = deadSeverity === 'critical' && status.counts.dead > 0;
        const transportDown = !transportHealthy(bus);
        return {
          status: deadCritical || transportDown ? 'unhealthy' : 'healthy',
          message: deadCritical
            ? `${status.counts.dead} dead outbox row(s)`
            : transportDown
              ? 'Acknowledged event transport is unavailable'
              : undefined,
          details: { dead: status.counts.dead, transportHealthy: !transportDown },
        };
      },
    },
    {
      name: 'event-reliability-warning',
      severity: 'warning',
      async check() {
        const status = await snapshot();
        const pendingAgeMs = status.oldestPendingAt
          ? Math.max(0, now().getTime() - Date.parse(status.oldestPendingAt))
          : 0;
        const deadWarning = deadSeverity === 'warning' && status.counts.dead > 0;
        const degraded = deadWarning || status.expiredLeases > 0 || pendingAgeMs > maxPendingAgeMs;
        return {
          status: degraded ? 'degraded' : 'healthy',
          message: degraded
            ? 'Transactional event delivery requires operator attention'
            : undefined,
          details: {
            pendingAgeMs,
            expiredLeases: status.expiredLeases,
            dead: status.counts.dead,
          },
        };
      },
    },
  ];
}

/** Register bounded store/status gauges and return lifecycle counter observers. */
export function registerEventReliabilityMetrics(
  state: MetricsState,
  operations: EventReliabilityOperations,
  store: 'postgres' | 'sqlite',
): {
  outbox(event: OutboxLifecycleEvent): void;
  inbox(event: InboxLifecycleEvent): void;
} {
  registerGaugeCallback(state, 'slingshot_event_outbox_rows', async () => {
    const status = await operations.status(new Date().toISOString());
    return Object.entries(status.counts).map(([rowStatus, value]) => ({
      labels: { store, status: rowStatus },
      value,
    }));
  });
  registerGaugeCallback(state, 'slingshot_event_outbox_expired_leases', async () => {
    const status = await operations.status(new Date().toISOString());
    return [{ labels: { store }, value: status.expiredLeases }];
  });
  return {
    outbox(event): void {
      incrementCounter(
        state,
        `slingshot_event_outbox_${event.action}_total`,
        {
          store,
          ...(event.transport ? { transport: event.transport } : {}),
        },
        event.count ?? 1,
      );
      if (event.durationMs !== undefined) {
        observeHistogram(
          state,
          'slingshot_event_outbox_publish_duration_seconds',
          { store, status: event.action },
          event.durationMs / 1_000,
        );
      }
      if (event.eventKey) {
        console.info(
          JSON.stringify({
            component: 'slingshot-events',
            action: event.action,
            eventKey: event.eventKey,
            eventId: event.eventIdShort,
          }),
        );
      }
    },
    inbox(event): void {
      incrementCounter(state, `slingshot_event_inbox_${event.action}_total`, { store });
    },
  };
}
