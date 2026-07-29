import type { TransactionScope } from '@lastshotlabs/slingshot-core';

/** SQL stores supported by transactional event reliability. */
export type EventReliabilityStore = 'postgres' | 'sqlite';

/** Retry timing for failed durable publication attempts. */
export interface EventRetryConfig {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly jitter: number;
}

/** Transactional outbox worker configuration. */
export interface EventOutboxConfig {
  readonly enabled: true;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly publicationTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly retry?: Partial<EventRetryConfig>;
  readonly deliveredRetentionDays?: number;
  readonly deadRetentionDays?: number;
}

/** Transactional consumer-inbox configuration. */
export interface EventInboxConfig {
  readonly enabled: true;
  readonly retentionDays?: number;
}

/** Readiness thresholds for transactional event infrastructure. */
export interface EventReliabilityReadinessConfig {
  readonly maxPendingAgeMs?: number;
  readonly deadRows?: 'warning' | 'critical';
}

/** Top-level configuration for transactional event reliability. */
export interface EventReliabilityConfig {
  readonly store: EventReliabilityStore;
  readonly outbox?: false | EventOutboxConfig;
  readonly inbox?: false | EventInboxConfig;
  readonly readiness?: EventReliabilityReadinessConfig;
}

/** Context supplied to one transactional inbox handler. */
export interface TransactionalEventConsumerContext {
  readonly scope: TransactionScope;
  readonly eventId: string;
  readonly consumerName: string;
}

/** Durable named-consumer options for SQL inbox deduplication. */
export interface TransactionalEventConsumerOptions {
  readonly durable: true;
  readonly name: string;
  readonly inbox: {
    readonly store: EventReliabilityStore;
  };
}
