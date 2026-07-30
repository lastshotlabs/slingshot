import type {
  EventDefinitionRegistry,
  EventEnvelope,
  EventKey,
  EventSchemaRegistry,
  EventVersionRegistry,
} from '@lastshotlabs/slingshot-core';
import { isEventEnvelope } from '@lastshotlabs/slingshot-core';

/** Stable incompatibility reasons surfaced to operators without validation internals. */
export type EventReplayIncompatibility =
  | 'invalid-envelope'
  | 'unknown-event'
  | 'future-version'
  | 'missing-adapter'
  | 'invalid-payload'
  | 'validator-unavailable';

/** Compatibility result produced before durable replay or publication. */
export type EventReplayValidation =
  | {
      readonly compatible: true;
      readonly eventKey: string;
      readonly storedVersion: number;
      readonly currentVersion: number;
      readonly adapted: boolean;
    }
  | {
      readonly compatible: false;
      readonly eventKey: string;
      readonly storedVersion: number;
      readonly currentVersion: number | null;
      readonly reason: EventReplayIncompatibility;
    };

/** Validates and prepares immutable stored envelopes for the current event contract. */
export interface EventReplayValidator {
  validate(envelopeJson: string, expectedEventKey?: string): EventReplayValidation;
  prepare(
    envelopeJson: string,
    expectedEventKey?: string,
  ): { readonly validation: EventReplayValidation; readonly envelope: EventEnvelope | null };
}

/** Dependencies for governed replay compatibility. */
export interface EventReplayValidatorOptions {
  readonly definitions: EventDefinitionRegistry;
  readonly schemas: EventSchemaRegistry;
  readonly versions: EventVersionRegistry;
}

function storedVersion(envelope: EventEnvelope): number {
  const version = envelope.meta.schemaVersion;
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

/** Create an instance-scoped replay validator from the app's governed registries. */
export function createEventReplayValidator(
  options: EventReplayValidatorOptions,
): EventReplayValidator {
  function prepare(
    envelopeJson: string,
    expectedEventKey?: string,
  ): { readonly validation: EventReplayValidation; readonly envelope: EventEnvelope | null } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envelopeJson);
    } catch {
      return {
        validation: {
          compatible: false,
          eventKey: expectedEventKey ?? '',
          storedVersion: 1,
          currentVersion: null,
          reason: 'invalid-envelope',
        },
        envelope: null,
      };
    }
    if (!isEventEnvelope(parsed) || (expectedEventKey && parsed.key !== expectedEventKey)) {
      return {
        validation: {
          compatible: false,
          eventKey: expectedEventKey ?? (isEventEnvelope(parsed) ? parsed.key : ''),
          storedVersion: isEventEnvelope(parsed) ? storedVersion(parsed) : 1,
          currentVersion: null,
          reason: 'invalid-envelope',
        },
        envelope: null,
      };
    }

    const eventKey = parsed.key;
    const fromVersion = storedVersion(parsed);
    const definition = options.definitions.get(eventKey as EventKey);
    if (!definition) {
      return {
        validation: {
          compatible: false,
          eventKey,
          storedVersion: fromVersion,
          currentVersion: null,
          reason: 'unknown-event',
        },
        envelope: null,
      };
    }
    if (fromVersion > definition.schemaVersion) {
      return {
        validation: {
          compatible: false,
          eventKey,
          storedVersion: fromVersion,
          currentVersion: definition.schemaVersion,
          reason: 'future-version',
        },
        envelope: null,
      };
    }

    let adaptation: ReturnType<EventVersionRegistry['adapt']>;
    try {
      adaptation = options.versions.adapt(
        eventKey,
        fromVersion,
        definition.schemaVersion,
        parsed.payload,
      );
    } catch {
      return {
        validation: {
          compatible: false,
          eventKey,
          storedVersion: fromVersion,
          currentVersion: definition.schemaVersion,
          reason: 'missing-adapter',
        },
        envelope: null,
      };
    }

    const validation = options.schemas.validate(eventKey, adaptation.payload);
    if (!validation.success) {
      return {
        validation: {
          compatible: false,
          eventKey,
          storedVersion: fromVersion,
          currentVersion: definition.schemaVersion,
          reason: 'invalid-payload',
        },
        envelope: null,
      };
    }

    const envelope = Object.freeze({
      ...parsed,
      payload: validation.data,
      meta: Object.freeze({
        ...parsed.meta,
        schemaVersion: definition.schemaVersion,
      }),
    }) as EventEnvelope;
    return {
      validation: {
        compatible: true,
        eventKey,
        storedVersion: fromVersion,
        currentVersion: definition.schemaVersion,
        adapted: adaptation.adapted,
      },
      envelope,
    };
  }

  return {
    validate(envelopeJson, expectedEventKey) {
      return prepare(envelopeJson, expectedEventKey).validation;
    },
    prepare,
  };
}
