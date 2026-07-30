import { describe, expect, test } from 'bun:test';
import { projectStoredEventEnvelope, redactEventPayload } from '../src/operatorProjection';

describe('event operator projection', () => {
  test('fully suppresses payloads from prohibited namespaces', () => {
    expect(redactEventPayload('security.auth.login.failure', { reason: 'secret' })).toBe(
      '[redacted]',
    );
    expect(redactEventPayload('auth:user.created', { token: 'secret' })).toBe('[redacted]');
  });

  test('treats legacy envelopes as version one and malformed rows as opaque', () => {
    expect(
      projectStoredEventEnvelope(
        JSON.stringify({
          key: 'orders:created',
          payload: { id: '1' },
          meta: { occurredAt: '2026-01-01T00:00:00Z', ownerPlugin: 'orders' },
        }),
      ).schemaVersion,
    ).toBe(1);
    expect(projectStoredEventEnvelope('not-json').payloadPreview).toBe('[invalid stored envelope]');
  });
});
