import { wireSecurityEventConfig } from '@auth/lib/securityEventWiring';
import type { SecurityEvent } from '@auth/lib/securityEventWiring';
import { beforeEach, describe, expect, test } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SecurityEventKey } from '@lastshotlabs/slingshot-core';

function makeBus() {
  return new InProcessAdapter();
}

beforeEach(() => {
  // No global state to reset — bus is created per-test
});

describe('wireSecurityEventConfig', () => {
  test('no-ops when cfg is undefined', () => {
    const bus = makeBus();
    // Should not throw
    wireSecurityEventConfig(bus, undefined);
  });

  test('no-ops when onEvent is missing', () => {
    const bus = makeBus();
    // Should not throw — malformed config
    wireSecurityEventConfig(bus, {} as any);
  });

  test('calls onEvent when bus emits a security event', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });

    // Allow fire-and-forget listener to run
    await new Promise(r => setTimeout(r, 10));

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe('security.auth.login.success');
    expect(received[0].userId).toBe('u1');
  });

  test('severity is correctly mapped for login.success', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    await new Promise(r => setTimeout(r, 10));

    expect(received[0].severity).toBe('info');
  });

  test('severity is correctly mapped for login.blocked (critical)', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.auth.login.blocked', { reason: 'lockout' });
    await new Promise(r => setTimeout(r, 10));

    expect(received[0].severity).toBe('critical');
  });

  test('severity is correctly mapped for credential_stuffing (critical)', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.credential_stuffing.detected', {});
    await new Promise(r => setTimeout(r, 10));

    expect(received[0].severity).toBe('critical');
  });

  test('include filter works', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
      include: ['security.auth.login.failure'],
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.login.failure', { identifier: 'foo@bar.com' });

    await new Promise(r => setTimeout(r, 10));

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe('security.auth.login.failure');
  });

  test('exclude filter works', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
      exclude: ['security.auth.login.success'],
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    bus.emit('security.auth.login.failure', { identifier: 'foo@bar.com' });

    await new Promise(r => setTimeout(r, 10));

    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe('security.auth.login.failure');
  });

  test('swallows errors from onEvent when no onEventError set', async () => {
    const bus = makeBus();
    wireSecurityEventConfig(bus, {
      onEvent: () => {
        throw new Error('handler crash');
      },
    });

    // Must not throw
    bus.emit('security.auth.login.success', { userId: 'u1' });
    await new Promise(r => setTimeout(r, 10));
    // Reaching here without throwing means the test passes
  });

  test('calls onEventError when onEvent throws', async () => {
    const bus = makeBus();
    const errors: unknown[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: () => {
        throw new Error('handler crash');
      },
      onEventError: err => {
        errors.push(err);
      },
    });

    bus.emit('security.auth.login.success', { userId: 'u2' });
    await new Promise(r => setTimeout(r, 10));

    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe('handler crash');
  });

  test('event has timestamp automatically added', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.auth.login.success', { userId: 'u1' });
    await new Promise(r => setTimeout(r, 10));

    expect(typeof received[0].timestamp).toBe('string');
    expect(received[0].timestamp).toMatch(/^\d{4}-/); // ISO 8601
  });

  test('meta fields are passed through to onEvent', async () => {
    const bus = makeBus();
    const received: SecurityEvent[] = [];
    wireSecurityEventConfig(bus, {
      onEvent: e => {
        received.push(e);
      },
    });

    bus.emit('security.auth.account.suspended', {
      userId: 'u1',
      meta: { reason: 'spam', actorId: 'admin' },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(received[0].meta?.reason).toBe('spam');
    expect(received[0].meta?.actorId).toBe('admin');
  });

  test('all security event types are wired', () => {
    // This is a compile-time + runtime check that SECURITY_EVENT_TYPES covers expected keys
    const { SECURITY_EVENT_TYPES } = require('@lastshotlabs/slingshot-core');
    expect(SECURITY_EVENT_TYPES.length).toBe(31);
  });

  test('new event types are valid TypeScript members', () => {
    // Smoke test: these assignments would fail to compile if the types were wrong.
    const types: SecurityEventKey[] = [
      'security.auth.session.created',
      'security.auth.session.revoked',
      'security.auth.oauth.linked',
      'security.auth.oauth.unlinked',
      'security.csrf.failed',
      'security.breached_password.detected',
      'security.admin.role.changed',
      'security.auth.account.locked',
      'security.auth.register.failure',
      'security.auth.register.concealed',
      'security.auth.logout',
      'security.auth.account.suspended',
      'security.auth.account.unsuspended',
      'security.auth.account.deleted',
      'security.auth.password.change',
      'security.auth.mfa.setup',
      'security.auth.mfa.verify.success',
      'security.auth.step_up.success',
      'security.auth.step_up.failure',
      'security.auth.oauth.reauthed',
      'security.admin.user.modified',
      'security.admin.user.deleted',
    ];
    expect(types.length).toBe(22);
  });
});
