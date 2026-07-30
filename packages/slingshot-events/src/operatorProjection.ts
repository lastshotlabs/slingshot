import type { EventEnvelope } from '@lastshotlabs/slingshot-core';

const REDACTED = '[redacted]';
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passphrase|secret|token|api[_-]?key|private[_-]?key)/iu;
const PROHIBITED_EVENT = /^(?:security[.:]|auth:|push:|community:delivery[.:])/u;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
const MAX_STRING_LENGTH = 2_000;

function redactString(value: string): string {
  const bounded =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  return bounded
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, '$1[redacted]@')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/giu, '$1=[redacted]');
}

/** Redact credentials and bound the size of one operator-visible text field. */
export function redactOperatorText(value: string): string {
  return redactString(value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map(item => redactValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, depth + 1);
  }
  return result;
}

/** Produce a bounded, recursively redacted payload preview for operator tooling. */
export function redactEventPayload(eventKey: string, payload: unknown): unknown {
  if (PROHIBITED_EVENT.test(eventKey)) return REDACTED;
  return redactValue(payload, 0);
}

/** Parse one stored envelope and return only the fields safe for operator projection. */
export function projectStoredEventEnvelope(envelopeJson: string): {
  readonly schemaVersion: number;
  readonly occurredAt: string | null;
  readonly ownerPlugin: string | null;
  readonly requestTenantId: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly source: string | null;
  readonly scope: unknown;
  readonly payloadPreview: unknown;
} {
  let parsed: Partial<EventEnvelope> & { meta?: Partial<EventEnvelope['meta']> };
  try {
    parsed = JSON.parse(envelopeJson) as Partial<EventEnvelope> & {
      meta?: Partial<EventEnvelope['meta']>;
    };
  } catch {
    return {
      schemaVersion: 1,
      occurredAt: null,
      ownerPlugin: null,
      requestTenantId: null,
      requestId: null,
      correlationId: null,
      source: null,
      scope: null,
      payloadPreview: '[invalid stored envelope]',
    };
  }
  const eventKey = typeof parsed.key === 'string' ? parsed.key : '';
  const meta = parsed.meta;
  const schemaVersion =
    typeof meta?.schemaVersion === 'number' &&
    Number.isSafeInteger(meta.schemaVersion) &&
    meta.schemaVersion > 0
      ? meta.schemaVersion
      : 1;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  return {
    schemaVersion,
    occurredAt: text(meta?.occurredAt),
    ownerPlugin: text(meta?.ownerPlugin),
    requestTenantId: text(meta?.requestTenantId),
    requestId: text(meta?.requestId),
    correlationId: text(meta?.correlationId),
    source: text(meta?.source),
    scope: redactValue(meta?.scope ?? null, 0),
    payloadPreview: redactEventPayload(eventKey, parsed.payload),
  };
}
