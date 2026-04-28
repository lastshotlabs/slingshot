/**
 * Header injection sanitization for kafka outbound headers.
 *
 * The Kafka wire protocol uses length-prefixed headers, so a CRLF in a value
 * does not split the wire frame, but downstream HTTP-bridged consumers
 * commonly emit these strings as response headers or log fields. The
 * outbound builder must therefore reject CR/LF/NUL at the boundary.
 */
import { describe, expect, test } from 'bun:test';
import { HeaderInjectionError, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';

describe('kafka outbound header sanitization', () => {
  test('createRawEventEnvelope does not throw on a malicious eventId at construction', () => {
    // The sanitizer fires at the kafka outbound boundary (buildEnvelopeHeaders),
    // not at envelope construction. Construction itself is permissive — sanitization
    // is enforced just-in-time when headers are written so a malformed envelope
    // can never reach the wire.
    expect(() =>
      createRawEventEnvelope('auth:login', { userId: 'u' }, {
        eventId: 'evt\r\nX-Injected: yes',
        ownerPlugin: 'auth',
        exposure: ['client'] as const,
        actorId: null,
        userId: null,
        scope: null,
        occurredAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        source: 'system',
        requestTenantId: null,
      } as never),
    ).not.toThrow();
  });

  test('sanitizeHeaderValue rejects the canonical attack payload', async () => {
    const { sanitizeHeaderValue } = await import('@lastshotlabs/slingshot-core');
    expect(() => sanitizeHeaderValue('foo\r\nX-Injected: yes', 'slingshot.tenant-id')).toThrow(
      HeaderInjectionError,
    );
  });
});
