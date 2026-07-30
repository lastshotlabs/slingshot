import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventDefinitionRegistry,
  createEventEnvelope,
  createEventSchemaRegistry,
  createEventVersionRegistry,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import { createEventReplayValidator } from '../src/replayValidation';

function validator() {
  const schemas = createEventSchemaRegistry();
  const definitions = createEventDefinitionRegistry({ schemaRegistry: schemas });
  definitions.register(
    defineEvent('app:ready', {
      schemaVersion: 2,
      ownerPlugin: 'framework',
      exposure: ['internal'],
      schema: z.object({ plugins: z.array(z.string()), source: z.string() }),
      resolveScope: () => null,
    }),
  );
  const versions = createEventVersionRegistry();
  versions.register({
    eventKey: 'app:ready',
    fromVersion: 1,
    toVersion: 2,
    adapt: payload => ({ ...(payload as object), source: 'legacy' }),
  });
  return createEventReplayValidator({ definitions, schemas, versions });
}

function envelope(schemaVersion: number, payload: unknown): string {
  return JSON.stringify(
    createEventEnvelope({
      key: 'app:ready',
      payload: payload as { plugins: string[] },
      schemaVersion,
      ownerPlugin: 'framework',
      exposure: ['internal'],
      scope: null,
      requestTenantId: null,
    }),
  );
}

describe('event replay validation', () => {
  test('adapts and validates without changing stored bytes or identity', () => {
    const stored = envelope(1, { plugins: ['a'] });
    const prepared = validator().prepare(stored, 'app:ready');

    expect(prepared.validation).toEqual({
      compatible: true,
      eventKey: 'app:ready',
      storedVersion: 1,
      currentVersion: 2,
      adapted: true,
    });
    expect(prepared.envelope?.payload as unknown).toEqual({ plugins: ['a'], source: 'legacy' });
    expect(prepared.envelope?.meta.schemaVersion).toBe(2);
    expect(JSON.parse(stored).meta.schemaVersion).toBe(1);
    expect(prepared.envelope?.meta.eventId).toBe(JSON.parse(stored).meta.eventId);
  });

  test('rejects unknown, future, malformed, and schema-invalid envelopes', () => {
    const current = validator();
    expect(current.validate(envelope(3, { plugins: [] }), 'app:ready')).toMatchObject({
      compatible: false,
      reason: 'future-version',
    });
    expect(current.validate('not-json', 'app:ready')).toMatchObject({
      compatible: false,
      reason: 'invalid-envelope',
    });
    expect(current.validate(envelope(2, { plugins: [] }), 'app:ready')).toMatchObject({
      compatible: false,
      reason: 'invalid-payload',
    });
    expect(current.validate(envelope(1, { plugins: [] }), 'other:event')).toMatchObject({
      compatible: false,
      reason: 'invalid-envelope',
    });
  });
});
