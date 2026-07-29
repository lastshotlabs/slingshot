import type { AcknowledgedEventBus, EventEnvelope } from '@lastshotlabs/slingshot-core';
import { isEventEnvelope, withTimeout } from '@lastshotlabs/slingshot-core';
import type { EventOutboxConfig } from '../types';
import type { LeasedOutboxRow, OutboxDispatchRepository } from './repository';

/** Injectable dispatcher dependencies used by production lifecycle and deterministic tests. */
export interface OutboxDispatcherOptions {
  readonly repository: OutboxDispatchRepository;
  readonly bus: AcknowledgedEventBus;
  readonly config: EventOutboxConfig;
  readonly owner?: string;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onError?: (error: unknown) => void;
  /** Bounded-cardinality lifecycle observer for metrics and structured logs. */
  readonly onLifecycle?: (event: OutboxLifecycleEvent) => void;
}

/** Dispatcher signal that never exposes a raw event ID or tenant. */
export interface OutboxLifecycleEvent {
  readonly action: 'claimed' | 'acknowledged' | 'retried' | 'dead';
  readonly count?: number;
  readonly eventKey?: string;
  readonly eventIdShort?: string;
  readonly transport?: 'bullmq' | 'kafka';
  readonly durationMs?: number;
}

/** Running transactional outbox worker. */
export interface OutboxDispatcher {
  readonly owner: string;
  start(): void;
  dispatchOnce(): Promise<number>;
  shutdown(): Promise<void>;
}

const DEFAULTS = {
  pollIntervalMs: 250,
  batchSize: 100,
  leaseMs: 30_000,
  publicationTimeoutMs: 10_000,
  shutdownGraceMs: 5_000,
  concurrency: 1,
  maxAttempts: 20,
  retry: { initialMs: 250, maxMs: 60_000, jitter: 0.2 },
} as const;

class PermanentOutboxPublicationError extends Error {}

function parseEnvelope(row: LeasedOutboxRow): EventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(row.envelopeJson);
  } catch (cause) {
    throw new PermanentOutboxPublicationError('Stored outbox envelope is not valid JSON.', {
      cause,
    });
  }
  if (!isEventEnvelope(value) || value.key !== row.eventKey || value.meta.eventId !== row.eventId) {
    throw new PermanentOutboxPublicationError(
      'Stored outbox envelope identity does not match its row.',
    );
  }
  return value;
}

function errorDetails(error: unknown): { code: string; message: string } {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const rawCode =
    typeof candidate?.code === 'string'
      ? candidate.code
      : typeof candidate?.name === 'string'
        ? candidate.name
        : 'OUTBOX_PUBLISH_FAILED';
  const rawMessage =
    typeof candidate?.message === 'string' ? candidate.message : 'Durable publication failed.';
  const sanitizedMessage = rawMessage
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]');
  return {
    code: rawCode.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128),
    message: sanitizedMessage.replace(/[\r\n\t]+/g, ' ').slice(0, 1_024),
  };
}

/** Create a lease-based, at-least-once outbox dispatcher. */
export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const owner = options.owner ?? globalThis.crypto.randomUUID();
  const config = {
    ...DEFAULTS,
    ...options.config,
    retry: { ...DEFAULTS.retry, ...options.config.retry },
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let active: Promise<number> | null = null;

  async function publish(row: LeasedOutboxRow): Promise<void> {
    const attempts = row.attempts + 1;
    const startedAt = Date.now();
    try {
      const envelope = parseEnvelope(row);
      const receipt = await withTimeout(
        options.bus.publishEnvelope(envelope),
        config.publicationTimeoutMs,
        `events.outbox.publish[${row.eventKey}]`,
      );
      if (receipt.eventId !== row.eventId) {
        throw new PermanentOutboxPublicationError(
          'Durable transport acknowledged a different event identity.',
        );
      }
      if (receipt.durableDestinations < 1) {
        throw new Error('Durable transport did not acknowledge this event identity.');
      }
      await options.repository.markDelivered({
        id: row.id,
        owner,
        deliveredAt: now().toISOString(),
      });
      options.onLifecycle?.({
        action: 'acknowledged',
        eventKey: row.eventKey,
        eventIdShort: row.eventId.slice(0, 8),
        transport: receipt.transport,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const details = errorDetails(error);
      const exponent = Math.min(30, attempts - 1);
      const base = Math.min(config.retry.maxMs, config.retry.initialMs * 2 ** exponent);
      const jitter = base * config.retry.jitter * (random() * 2 - 1);
      const availableAt = new Date(now().getTime() + Math.max(0, base + jitter)).toISOString();
      const dead =
        error instanceof PermanentOutboxPublicationError || attempts >= config.maxAttempts;
      await options.repository.release({
        id: row.id,
        owner,
        attempts,
        availableAt,
        errorCode: details.code,
        errorMessage: details.message,
        dead,
      });
      options.onLifecycle?.({
        action: dead ? 'dead' : 'retried',
        eventKey: row.eventKey,
        eventIdShort: row.eventId.slice(0, 8),
        durationMs: Date.now() - startedAt,
      });
      options.onError?.(error);
    }
  }

  async function dispatchOnce(): Promise<number> {
    if (stopped) return 0;
    if (active) return active;
    active = (async () => {
      const claimed = await options.repository.claim({
        owner,
        limit: config.batchSize,
        now: now().toISOString(),
        leaseExpiresAt: new Date(now().getTime() + config.leaseMs).toISOString(),
      });
      if (claimed.length > 0) {
        options.onLifecycle?.({ action: 'claimed', count: claimed.length });
      }
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(config.concurrency, claimed.length) },
        async () => {
          while (!stopped) {
            const index = cursor++;
            const row = claimed[index];
            if (!row) return;
            await publish(row);
          }
        },
      );
      await Promise.all(workers);
      return claimed.length;
    })().finally(() => {
      active = null;
    });
    return active;
  }

  function schedule(): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void dispatchOnce()
        .catch(options.onError ?? (() => undefined))
        .finally(schedule);
    }, config.pollIntervalMs);
    timer.unref?.();
  }

  return {
    owner,
    start(): void {
      if (stopped) throw new Error('Outbox dispatcher cannot restart after shutdown.');
      schedule();
    },
    dispatchOnce,
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active) {
        try {
          await withTimeout(active, config.shutdownGraceMs, 'events.outbox.shutdown');
        } catch {
          // The owner release below recovers unfinished work.
        }
      }
      await options.repository.releaseOwner(owner, now().toISOString());
    },
  };
}
