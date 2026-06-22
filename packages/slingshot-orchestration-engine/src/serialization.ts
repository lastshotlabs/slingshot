import { OrchestrationError } from './errors';

/**
 * Default maximum serialized payload size in bytes (1 MiB).
 *
 * Adapter implementations apply this limit to JSON-serialized task and workflow
 * inputs as well as task outputs to prevent runaway payloads from blowing past
 * the durable store's row size limits or DoSing dependent services.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;

/**
 * Hard ceiling that bounds adapter-configurable `maxPayloadBytes` overrides so
 * a misconfiguration cannot disable the limit entirely.
 */
export const PAYLOAD_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * Resolve an adapter-supplied `maxPayloadBytes` option to a finite, positive
 * integer, falling back to the default. Throws `INVALID_CONFIG` when the value
 * is malformed.
 */
export function resolveMaxPayloadBytes(value: number | undefined, label = 'adapter'): number {
  if (value === undefined) return DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `${label} maxPayloadBytes must be a positive integer.`,
    );
  }
  if (value > PAYLOAD_BYTES_CEILING) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `${label} maxPayloadBytes ${value} exceeds ceiling ${PAYLOAD_BYTES_CEILING}.`,
    );
  }
  return value;
}

/**
 * JSON-serialize `value` and reject with `PAYLOAD_TOO_LARGE` when the byte
 * length exceeds `maxBytes`. The caller controls the descriptive label used in
 * error messages (e.g. `task 'send-email' input`, `workflow output`).
 *
 * `undefined` values (and anything else that JSON.stringify drops to
 * `undefined`) are treated as a zero-byte payload to match adapter call sites
 * that historically accepted optional inputs.
 */
export function serializeWithLimit(value: unknown, maxBytes: number, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `${label} could not be serialized to JSON: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
  if (serialized === undefined) {
    // JSON.stringify returns undefined for top-level undefined/functions/symbols.
    // Treat as empty so optional inputs like `runTask(name)` continue to work.
    return '';
  }
  // Use Buffer.byteLength when available for accurate UTF-8 byte counts; fall
  // back to TextEncoder for non-Node runtimes.
  const byteLength =
    typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
      ? Buffer.byteLength(serialized, 'utf8')
      : new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    throw new OrchestrationError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum payload size: ${byteLength} bytes > ${maxBytes} bytes.`,
    );
  }
  return serialized;
}

/**
 * Verify that `value` would JSON-serialize within `maxBytes` without retaining
 * the serialized string. Used by adapters that store the original value in
 * memory but want to assert the persistable size up front.
 */
export function assertPayloadSize(value: unknown, maxBytes: number, label: string): void {
  serializeWithLimit(value, maxBytes, label);
}
