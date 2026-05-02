import { createConsoleLogger } from '@lastshotlabs/slingshot-core';
import type { Logger, LogFields } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An audit event emitted by the admin plugin for CRUD operations.
 *
 * Designed for admin-specific use — provides a higher-level view of who did
 * what to which resource and whether it succeeded.  The core `AuditLogProvider`
 * interface used elsewhere in the plugin remains available for apps that need
 * the full request-level event detail.
 */
export interface AdminAuditEvent {
  /** ISO 8601 timestamp of the event. */
  readonly timestamp: string;
  /** Route path pattern, e.g. "/users/:userId". */
  readonly route: string;
  /** HTTP method, e.g. "GET", "POST", "DELETE". */
  readonly method: string;
  /** Actor / user id who performed the action. */
  readonly actor: string;
  /**
   * Action verb, e.g. "user.list", "user.get", "user.delete",
   * "user.suspend", "permission.evaluate", "permission.registry.read",
   * "mail.preview".
   */
  readonly action: string;
  /** Target resource identifier (user id, grant id, template name, etc.). */
  readonly target: string;
  /** Outcome of the operation. */
  readonly result: 'success' | 'failure';
  /** Error message when result is "failure". */
  readonly error?: string;
  /** Tenant scope when the admin principal was tenant-scoped. */
  readonly tenantId?: string;
}

/**
 * Pluggable audit logger for admin operations.
 *
 * Implementations may write to an in-memory store, a structured logger, or
 * forward events to an external audit backend.
 */
export interface AdminAuditLogger {
  /**
   * Record an audit event.
   *
   * May be sync or async. Errors are caught and logged by the caller so an
   * audit backend failure never propagates to the HTTP response.
   */
  log(event: AdminAuditEvent): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (testing / small deployments)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory admin audit logger.
 *
 * Events are stored in an array and never persisted. Useful for testing and
 * single-instance deployments where a durable audit trail is not required.
 *
 * The returned object includes `getEvents()` and `clear()` helpers for test
 * assertions and state reset.
 */
export function createMemoryAuditLogger(): AdminAuditLogger & {
  getEvents(): readonly AdminAuditEvent[];
  clear(): void;
} {
  const events: AdminAuditEvent[] = [];

  return {
    log(event: AdminAuditEvent): void {
      events.push(event);
    },

    getEvents(): readonly AdminAuditEvent[] {
      return events;
    },

    clear(): void {
      events.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Console implementation (development / lightweight production)
// ---------------------------------------------------------------------------

/**
 * Create a console-backed admin audit logger.
 *
 * Writes each event as a structured JSON log line via the provided logger
 * (defaults to a console logger with `{ plugin: 'slingshot-admin' }` base).
 */
export function createConsoleAuditLogger(baseLogger?: Logger): AdminAuditLogger {
  const logger: Logger =
    baseLogger ?? createConsoleLogger({ base: { plugin: 'slingshot-admin' } });

  return {
    log(event: AdminAuditEvent): void {
      logger.info('admin-audit-event', event as unknown as LogFields);
    },
  };
}
