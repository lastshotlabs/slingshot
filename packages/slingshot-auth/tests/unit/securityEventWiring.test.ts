import { describe, expect, it, mock } from 'bun:test';
import { InProcessAdapter, SECURITY_EVENT_TYPES } from '@lastshotlabs/slingshot-core';
import type { SecurityEventKey } from '@lastshotlabs/slingshot-core';
import {
  type SecurityEvent,
  type SecurityEventsConfig,
  wireSecurityEventConfig,
} from '../../src/lib/securityEventWiring';

/**
 * Expected severity for every event key wired through SECURITY_EVENT_TYPES.
 * Mirrors the SEVERITY_MAP in the source — tests fail if either side drifts.
 */
const EXPECTED_SEVERITIES: Record<SecurityEventKey, 'info' | 'warn' | 'critical'> = {
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

describe('wireSecurityEventConfig', () => {
  // -----------------------------------------------------------------------
  // 1. Basic wiring — subscribes to events on the bus
  // -----------------------------------------------------------------------
  it('subscribes to all SECURITY_EVENT_TYPES on the bus', () => {
    const bus = new InProcessAdapter();
    const onEvent = mock(() => {});
    wireSecurityEventConfig(bus, { onEvent });

    // Emit every security event and verify onEvent is called for each
    const emptyObj = {};
    const emptyPayload = emptyObj as never;
    for (const eventType of SECURITY_EVENT_TYPES) {
      bus.emit(eventType, emptyPayload);
    }

    expect(onEvent).toHaveBeenCalledTimes(SECURITY_EVENT_TYPES.length);
  });

  // -----------------------------------------------------------------------
  // 2. Severity mapping — events get correct severity
  // -----------------------------------------------------------------------
  it('maps login.success to severity "info"', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.auth.login.success', { userId: 'u1' });

    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('info');
  });

  it('maps login.failure to severity "warn"', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.auth.login.failure', { reason: 'bad-password' });

    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('warn');
  });

  it('maps login.blocked to severity "critical"', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.auth.login.blocked', { reason: 'lockout' });

    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('critical');
  });

  // -----------------------------------------------------------------------
  // 3. onEvent callback — receives enriched payload
  // -----------------------------------------------------------------------
  it('delivers eventType, severity, timestamp, and original payload fields', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.auth.login.success', {
      userId: 'usr_42',
      sessionId: 'sess_1',
      ip: '10.0.0.1',
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.eventType).toBe('security.auth.login.success');
    expect(event.severity).toBe('info');
    expect(event.userId).toBe('usr_42');
    expect(event.sessionId).toBe('sess_1');
    expect(event.ip).toBe('10.0.0.1');
    expect(typeof event.timestamp).toBe('string');
  });

  // -----------------------------------------------------------------------
  // 4. Include filter — only specified events trigger callback
  // -----------------------------------------------------------------------
  it('only fires for events in the include list', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => events.push(e),
      include: ['security.auth.login.success', 'security.auth.logout'],
    });

    // Fire included events
    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.logout', { userId: 'u1' });
    // Fire excluded event
    bus.emit('security.auth.login.failure', { reason: 'bad' });

    expect(events).toHaveLength(2);
    expect(events.map(e => e.eventType)).toEqual([
      'security.auth.login.success',
      'security.auth.logout',
    ]);
  });

  // -----------------------------------------------------------------------
  // 5. Exclude filter — excluded events don't trigger callback
  // -----------------------------------------------------------------------
  it('skips events in the exclude list', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => events.push(e),
      exclude: ['security.auth.login.success'],
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.login.failure', { reason: 'bad' });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('security.auth.login.failure');
  });

  it('exclude takes precedence over include', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => events.push(e),
      include: ['security.auth.login.success', 'security.auth.login.failure'],
      exclude: ['security.auth.login.success'],
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.login.failure', { reason: 'bad' });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('security.auth.login.failure');
  });

  // -----------------------------------------------------------------------
  // 6. onEventError — errors in onEvent are caught and forwarded
  // -----------------------------------------------------------------------
  it('calls onEventError when onEvent throws', () => {
    const bus = new InProcessAdapter();
    const thrownError = new Error('callback boom');
    const errors: unknown[] = [];

    wireSecurityEventConfig(bus, {
      onEvent: () => {
        throw thrownError;
      },
      onEventError: err => errors.push(err),
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(thrownError);
  });

  it('logs to console.error when onEvent throws and no onEventError provided', () => {
    const bus = new InProcessAdapter();
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);

    try {
      wireSecurityEventConfig(bus, {
        onEvent: () => {
          throw new Error('no handler');
        },
      });

      bus.emit('security.auth.login.success', { userId: 'u1' });

      expect(logged).toHaveLength(1);
      expect(logged[0][0]).toBe('[slingshot-auth][security-events]');
      expect(logged[0][1]).toBeInstanceOf(Error);
    } finally {
      console.error = originalError;
    }
  });

  // -----------------------------------------------------------------------
  // 7. Missing onEvent — no crash when cfg is undefined or onEvent absent
  // -----------------------------------------------------------------------
  it('is a no-op when cfg is undefined', () => {
    const bus = new InProcessAdapter();
    // Should not throw
    wireSecurityEventConfig(bus, undefined);
    bus.emit('security.auth.login.success', { userId: 'u1' });
  });

  it('is a no-op when cfg has no onEvent', () => {
    const bus = new InProcessAdapter();
    const cfgObj = {};
    const emptyCfg = cfgObj as SecurityEventsConfig;
    wireSecurityEventConfig(bus, emptyCfg);
    bus.emit('security.auth.login.success', { userId: 'u1' });
  });

  // -----------------------------------------------------------------------
  // 8. Timestamp — event payload includes ISO-8601 timestamp
  // -----------------------------------------------------------------------
  it('includes an ISO-8601 timestamp in the event', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    const before = new Date().toISOString();
    bus.emit('security.auth.logout', { userId: 'u1' });
    const after = new Date().toISOString();

    expect(events).toHaveLength(1);
    const ts = events[0].timestamp;
    // Validate ISO-8601 format
    expect(new Date(ts).toISOString()).toBe(ts);
    // Validate reasonable range
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 9. Multiple events — different events map to different severities
  // -----------------------------------------------------------------------
  it('maps different event types to their respective severities', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.auth.login.success', { userId: 'u1' }); // info
    bus.emit('security.auth.account.locked', { userId: 'u2' }); // critical
    bus.emit('security.rate_limit.exceeded', { key: 'k1' }); // warn
    bus.emit('security.credential_stuffing.detected', { type: 'ip' }); // critical

    expect(events).toHaveLength(4);
    expect(events[0].severity).toBe('info');
    expect(events[1].severity).toBe('critical');
    expect(events[2].severity).toBe('warn');
    expect(events[3].severity).toBe('critical');
  });

  // -----------------------------------------------------------------------
  // 10. All security events registered — every event in SECURITY_EVENT_TYPES
  //     gets a handler
  // -----------------------------------------------------------------------
  it('wires a handler for every event in SECURITY_EVENT_TYPES', () => {
    const bus = new InProcessAdapter();
    const wiredEvents = new Set<string>();
    wireSecurityEventConfig(bus, {
      onEvent: e => wiredEvents.add(e.eventType),
    });

    const emptyObj = {};
    const emptyPayload = emptyObj as never;
    for (const eventType of SECURITY_EVENT_TYPES) {
      bus.emit(eventType, emptyPayload);
    }

    for (const eventType of SECURITY_EVENT_TYPES) {
      expect(wiredEvents.has(eventType)).toBe(true);
    }
    expect(wiredEvents.size).toBe(SECURITY_EVENT_TYPES.length);
  });

  // -----------------------------------------------------------------------
  // 11. Severity coverage — every SECURITY_EVENT_TYPES entry has a known
  //     severity (not a fallback)
  // -----------------------------------------------------------------------
  it('every event in SECURITY_EVENT_TYPES has a severity in the expected map', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    const emptyObj = {};
    const emptyPayload = emptyObj as never;
    for (const eventType of SECURITY_EVENT_TYPES) {
      bus.emit(eventType, emptyPayload);
    }

    for (const event of events) {
      const expected = EXPECTED_SEVERITIES[event.eventType];
      expect(expected).toBeDefined();
      expect(event.severity).toBe(expected);
    }
  });

  // -----------------------------------------------------------------------
  // 12. Payload pass-through — original bus payload fields are merged into
  //     the SecurityEvent
  // -----------------------------------------------------------------------
  it('merges bus payload fields into the security event', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, { onEvent: e => events.push(e) });

    bus.emit('security.credential_stuffing.detected', {
      type: 'ip',
      key: '192.168.1.1',
      count: 50,
      ip: '192.168.1.1',
      meta: { source: 'waf' },
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.eventType).toBe('security.credential_stuffing.detected');
    expect(event.severity).toBe('critical');
    expect((event as Record<string, unknown>)['type']).toBe('ip');
    expect((event as Record<string, unknown>)['key']).toBe('192.168.1.1');
    expect((event as Record<string, unknown>)['count']).toBe(50);
    expect(event.ip).toBe('192.168.1.1');
    expect(event.meta).toEqual({ source: 'waf' });
  });

  // -----------------------------------------------------------------------
  // 13. Empty include array behaves as "subscribe to all"
  // -----------------------------------------------------------------------
  it('treats an empty include array as no filter (subscribes to all)', () => {
    const bus = new InProcessAdapter();
    const events: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => events.push(e),
      include: [],
    });

    const emptyObj = {};
    const emptyPayload = emptyObj as never;
    for (const eventType of SECURITY_EVENT_TYPES) {
      bus.emit(eventType, emptyPayload);
    }

    expect(events).toHaveLength(SECURITY_EVENT_TYPES.length);
  });

  // -----------------------------------------------------------------------
  // 14. Multiple onEvent errors — each error is forwarded independently
  // -----------------------------------------------------------------------
  it('forwards each error independently to onEventError', () => {
    const bus = new InProcessAdapter();
    const errors: unknown[] = [];
    let callCount = 0;

    wireSecurityEventConfig(bus, {
      onEvent: () => {
        callCount++;
        throw new Error(`error-${callCount}`);
      },
      onEventError: err => errors.push(err),
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.login.failure', { reason: 'bad' });

    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('error-1');
    expect((errors[1] as Error).message).toBe('error-2');
  });
});
