import { z } from 'zod';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { isAcknowledgedEventBus } from '@lastshotlabs/slingshot-core';
import { EventReliabilityTopologyError } from './errors';
import type { EventReliabilityConfig } from './types';

const positiveInteger = (description: string, maximum: number) =>
  z.number().int().positive().max(maximum).describe(description);

/** Zod schema for outbox retry timing. */
export const eventRetryConfigSchema = z
  .object({
    initialMs: positiveInteger(
      'Initial durable publication retry delay in milliseconds.',
      60_000,
    ).default(250),
    maxMs: positiveInteger(
      'Maximum durable publication retry delay in milliseconds.',
      3_600_000,
    ).default(60_000),
    jitter: z
      .number()
      .min(0)
      .max(1)
      .describe('Fractional random jitter applied to publication retry delays.')
      .default(0.2),
  })
  .strict()
  .describe('Backoff policy for failed outbox publication attempts.');

/** Zod schema for transactional outbox configuration. */
export const eventOutboxConfigSchema = z
  .object({
    enabled: z.literal(true).describe('Enable transactional outbox persistence and dispatch.'),
    pollIntervalMs: positiveInteger('Milliseconds between dispatcher polls.', 60_000).default(250),
    batchSize: positiveInteger('Maximum rows claimed by one dispatcher poll.', 10_000).default(100),
    leaseMs: positiveInteger(
      'Milliseconds before an abandoned dispatch lease expires.',
      3_600_000,
    ).default(30_000),
    publicationTimeoutMs: positiveInteger(
      'Maximum milliseconds allowed for one acknowledged broker publication.',
      600_000,
    ).default(10_000),
    shutdownGraceMs: positiveInteger(
      'Milliseconds allowed to drain acknowledged publications during shutdown.',
      600_000,
    ).default(5_000),
    concurrency: positiveInteger('Maximum concurrent dispatcher publications.', 128).default(1),
    maxAttempts: positiveInteger(
      'Maximum publication attempts before a row becomes dead.',
      10_000,
    ).default(20),
    retry: eventRetryConfigSchema.default({
      initialMs: 250,
      maxMs: 60_000,
      jitter: 0.2,
    }),
    deliveredRetentionDays: positiveInteger('Days to retain delivered outbox rows.', 3_650).default(
      7,
    ),
    deadRetentionDays: positiveInteger('Days to retain dead outbox rows.', 3_650).default(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.leaseMs <= value.publicationTimeoutMs + value.shutdownGraceMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['leaseMs'],
        message: 'leaseMs must exceed publicationTimeoutMs plus shutdownGraceMs.',
      });
    }
    const retryHorizonDays = (value.maxAttempts * value.retry.maxMs) / 86_400_000;
    if (value.deadRetentionDays < retryHorizonDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['deadRetentionDays'],
        message: 'deadRetentionDays must not be shorter than the maximum retry horizon.',
      });
    }
  })
  .describe('Transactional outbox worker and retention settings.');

/** Zod schema for transactional inbox configuration. */
export const eventInboxConfigSchema = z
  .object({
    enabled: z.literal(true).describe('Enable transactional consumer inbox deduplication.'),
    retentionDays: positiveInteger('Days to retain processed inbox receipts.', 3_650).default(30),
  })
  .strict()
  .describe('Transactional inbox retention settings.');

/** Zod schema for transactional-event readiness thresholds. */
export const eventReliabilityReadinessConfigSchema = z
  .object({
    maxPendingAgeMs: positiveInteger(
      'Oldest pending row age before readiness degrades.',
      86_400_000,
    ).default(60_000),
    deadRows: z
      .enum(['warning', 'critical'])
      .describe('Readiness severity when dead outbox rows exist.')
      .default('critical'),
  })
  .strict()
  .describe('Readiness policy for transactional event infrastructure.');

/** Zod schema for top-level `events.reliability` configuration. */
export const eventReliabilityConfigSchema = z
  .object({
    store: z
      .enum(['postgres', 'sqlite'])
      .describe('SQL store shared by domain transactions and event reliability tables.'),
    outbox: z
      .union([z.literal(false), eventOutboxConfigSchema])
      .optional()
      .describe('Transactional outbox settings, or false to disable outbox delivery.'),
    inbox: z
      .union([z.literal(false), eventInboxConfigSchema])
      .optional()
      .describe('Transactional inbox settings, or false to disable inbox deduplication.'),
    readiness: eventReliabilityReadinessConfigSchema
      .optional()
      .describe('Optional readiness thresholds for durable event processing.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.outbox && !value.inbox) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one of events.reliability.outbox or inbox must be enabled.',
      });
    }
    if (value.store === 'sqlite' && value.outbox && value.outbox.concurrency !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['outbox', 'concurrency'],
        message: 'SQLite outbox concurrency must be exactly 1.',
      });
    }
  })
  .describe('Transactional outbox/inbox reliability configuration.');

/** Input used to reject unsupported reliability topology before infrastructure access. */
export interface EventReliabilityTopologyInput {
  readonly config: EventReliabilityConfig;
  readonly bus: SlingshotEventBus;
  readonly postgresConfigured: boolean;
  readonly sqliteConfigured: boolean;
}

/**
 * Validate cross-component event reliability requirements before migrations or workers start.
 */
export function validateEventReliabilityTopology(input: EventReliabilityTopologyInput): void {
  const parsed = eventReliabilityConfigSchema.parse(input.config);
  if (parsed.store === 'postgres' && !input.postgresConfigured) {
    throw new EventReliabilityTopologyError(
      "events.reliability.store is 'postgres', but db.postgres is not configured.",
    );
  }
  if (parsed.store === 'sqlite' && !input.sqliteConfigured) {
    throw new EventReliabilityTopologyError(
      "events.reliability.store is 'sqlite', but db.sqlite is not configured.",
    );
  }
  if (parsed.outbox && !isAcknowledgedEventBus(input.bus)) {
    throw new EventReliabilityTopologyError(
      'Transactional outbox delivery requires an AcknowledgedEventBus.',
    );
  }
}
