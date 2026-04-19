import type { EventSchemaRegistry } from './eventSchemaRegistry';

/**
 * Controls how event payloads are encoded for durable transport (Kafka topics,
 * BullMQ queues) and decoded on the consumer side.
 *
 * Non-durable listeners always receive the original in-process object — the
 * serializer is only invoked on durable produce and consume paths.
 */
export interface EventSerializer {
  /**
   * Human-readable content type for the wire format.
   */
  readonly contentType: string;

  /**
   * Encode an event payload for durable transport.
   */
  serialize(event: string, payload: unknown): Uint8Array;

  /**
   * Decode a durable message back into an event payload.
   */
  deserialize(event: string, data: Uint8Array): unknown;
}

/**
 * Default JSON serializer. Matches the existing behavior in BullMQ and Kafka
 * adapters — `JSON.stringify` on produce, `JSON.parse` on consume.
 */
export class JsonEventSerializer implements EventSerializer {
  readonly contentType = 'application/json';

  serialize(_event: string, payload: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(payload));
  }

  deserialize(_event: string, data: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(data));
  }
}

/**
 * Singleton JSON serializer instance. Stateless and safe to share.
 */
export const JSON_SERIALIZER: EventSerializer = new JsonEventSerializer();

/**
 * Controls how adapters handle schema validation failures.
 */
export type ValidationMode = 'strict' | 'warn' | 'off';

/**
 * Shared adapter options for runtime event validation and custom durable
 * serialization.
 */
export interface EventBusSerializationOptions {
  /**
   * Custom serializer for durable event transport. When omitted, adapters use
   * JSON serialization.
   */
  serializer?: EventSerializer;

  /**
   * Schema registry for runtime payload validation.
   */
  schemaRegistry?: EventSchemaRegistry;

  /**
   * Validation mode. Only has effect when `schemaRegistry` is provided.
   * Defaults to `'off'`.
   */
  validation?: ValidationMode;
}
