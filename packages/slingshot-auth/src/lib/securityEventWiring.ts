import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { SECURITY_EVENT_TYPES, type SecurityEventKey } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for the security event tap.
 *
 * When provided via `AuthPluginConfig.securityEvents`, every security event emitted by the
 * auth plugin is forwarded to `onEvent` after being enriched with `severity`, `timestamp`,
 * and contextual fields. Use this to ship events to a SIEM, audit log, or alerting system.
 *
 * @example
 * createAuthPlugin({
 *   securityEvents: {
 *     onEvent: (event) => {
 *       if (event.severity === 'critical') alerting.send(event);
 *       auditLog.write(event);
 *     },
 *     exclude: ['security.auth.login.success'], // skip noisy events
 *   },
 * });
 */
export interface SecurityEventsConfig {
  onEvent: (event: SecurityEvent) => void;
  onEventError?: (err: unknown) => void;
  include?: SecurityEventKey[];
  exclude?: SecurityEventKey[];
}

// Severity mapping per event type
const SEVERITY_MAP: Record<SecurityEventKey, 'info' | 'warn' | 'critical'> = {
  'security.auth.login.success': 'info',
  'security.auth.login.failure': 'warn',
  'security.auth.login.blocked': 'critical',
  'security.auth.register.success': 'info',
  'security.auth.register.failure': 'warn',
  'security.auth.register.concealed': 'info',
  'security.auth.logout': 'info',
  'security.auth.account.locked': 'critical',
  'security.auth.account.suspended': 'warn',
  'security.auth.account.unsuspended': 'info',
  'security.auth.account.deleted': 'warn',
  'security.auth.session.created': 'info',
  'security.auth.session.fingerprint_mismatch': 'critical',
  'security.auth.session.revoked': 'info',
  'security.auth.password.reset': 'info',
  'security.auth.password.change': 'info',
  'security.auth.mfa.setup': 'info',
  'security.auth.mfa.verify.success': 'info',
  'security.auth.mfa.verify.failure': 'warn',
  'security.auth.step_up.success': 'info',
  'security.auth.step_up.failure': 'warn',
  'security.auth.oauth.linked': 'info',
  'security.auth.oauth.unlinked': 'info',
  'security.auth.oauth.reauthed': 'info',
  'security.rate_limit.exceeded': 'warn',
  'security.credential_stuffing.detected': 'critical',
  'security.csrf.failed': 'warn',
  'security.breached_password.detected': 'warn',
  'security.breached_password.api_failure': 'warn',
  'security.admin.role.changed': 'warn',
  'security.admin.user.modified': 'info',
  'security.admin.user.deleted': 'warn',
};

/**
 * A security event payload delivered to `SecurityEventsConfig.onEvent`.
 *
 * `eventType` is one of the known `SecurityEventKey` values (e.g.
 * `'security.auth.login.failure'`). `severity` is derived from a fixed mapping per
 * event type. All other fields are optional and populated from the request context
 * when available.
 *
 * Additional properties (e.g. `identifier`, `reason`) may be present in the `meta`
 * field for certain event types. The index signature allows forward-compatible access.
 *
 * @example
 * const handler = (event: SecurityEvent) => {
 *   console.log(`[${event.severity.toUpperCase()}] ${event.eventType}`, {
 *     userId: event.userId,
 *     ip: event.ip,
 *   });
 * };
 */
export interface SecurityEvent {
  eventType: SecurityEventKey;
  severity: 'info' | 'warn' | 'critical';
  timestamp: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  tenantId?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Subscribes to all (or a filtered subset of) auth security events on the event bus and
 * forwards them to the application-supplied `onEvent` callback.
 *
 * Iterates over every event key in `SECURITY_EVENT_TYPES` and registers a listener via
 * `bus.on()`.  For each matching event the listener constructs a `SecurityEvent` payload
 * by merging the bus payload with a fixed `eventType`, `severity` (from the static
 * severity map), and ISO-8601 `timestamp`, then calls `cfg.onEvent()`.
 *
 * Security events wired:
 * - Login success / failure / blocked
 * - Registration success / failure / concealed
 * - Logout
 * - Account locked / suspended / unsuspended / deleted
 * - Session created / revoked
 * - Password reset / change
 * - MFA setup / verify success / verify failure
 * - Step-up success / failure
 * - OAuth linked / unlinked / reauthenticated
 * - Rate limit exceeded
 * - Credential stuffing detected
 * - CSRF failed
 * - Breached password detected / API failure
 * - Admin role changed / user modified / user deleted
 *
 * @param bus - The `SlingshotEventBus` instance to subscribe on.
 * @param cfg - Security event config from `AuthPluginConfig.securityEvents`.  When
 *   `undefined` or when `cfg.onEvent` is absent, this function is a no-op.
 *   - `onEvent`      — Called for each matching event. Must not throw; errors are caught
 *                      and forwarded to `onEventError` (or logged to `console.error`).
 *   - `onEventError` — Optional error handler for exceptions thrown inside `onEvent`.
 *   - `include`      — When non-empty, only these event keys are subscribed.
 *   - `exclude`      — Event keys to skip even when present in `include` (or by default).
 *
 * @example
 * wireSecurityEventConfig(bus, {
 *   onEvent: event => auditLog.write(event),
 *   onEventError: err => console.error('[security-events]', err),
 *   exclude: ['security.auth.login.success'],
 * });
 */
export function wireSecurityEventConfig(bus: SlingshotEventBus, cfg?: SecurityEventsConfig): void {
  if (!cfg?.onEvent) return;
  const { onEvent, onEventError, include = [], exclude = [] } = cfg;

  for (const eventType of SECURITY_EVENT_TYPES) {
    if (include.length > 0 && !include.includes(eventType)) continue;
    if (exclude.includes(eventType)) continue;

    bus.on(eventType, payload => {
      const event: SecurityEvent = {
        eventType,
        severity: SEVERITY_MAP[eventType],
        timestamp: new Date().toISOString(),
        ...(payload as Record<string, unknown>),
      };
      try {
        onEvent(event);
      } catch (err) {
        if (onEventError) {
          onEventError(err);
        } else {
          console.error('[slingshot-auth][security-events]', err);
        }
      }
    });
  }
}
