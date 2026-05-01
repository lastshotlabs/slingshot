import { type z } from 'zod';
import type { ValidationMode } from './eventTypes';
import { noopLogger } from './observability/logger';
import type { Logger } from './observability/logger';

/**
 * Result of validating an event payload against a registered schema.
 */
export type EventValidationResult =
  | { success: true; data: unknown }
  | { success: false; error: z.ZodError };

/**
 * Registry for event payload schemas. Plugins register Zod schemas for their
 * events during setup.
 */
export interface EventSchemaRegistry {
  /**
   * Register a Zod schema for an event key.
   */
  register(event: string, schema: z.ZodType): void;

  /**
   * Validate a payload against the registered schema for an event.
   */
  validate(event: string, payload: unknown): EventValidationResult;

  /**
   * Look up the schema registered for an event key.
   */
  get(event: string): z.ZodType | undefined;

  /**
   * Check whether a schema is registered for an event key.
   */
  has(event: string): boolean;

  /**
   * Returns all registered event keys.
   */
  keys(): IterableIterator<string>;

  /**
   * Number of registered schemas.
   */
  readonly size: number;
}

/**
 * Creates a new event schema registry instance.
 */
export function createEventSchemaRegistry(): EventSchemaRegistry {
  const schemas = new Map<string, z.ZodType>();

  return {
    register(event: string, schema: z.ZodType): void {
      if (schemas.has(event)) {
        throw new Error(
          `[EventSchemaRegistry] schema already registered for event "${event}". ` +
            'Schemas are immutable once registered. Use a new event key for breaking changes.',
        );
      }
      schemas.set(event, schema);
    },

    validate(event: string, payload: unknown): EventValidationResult {
      const schema = schemas.get(event);
      if (!schema) {
        return { success: true, data: payload };
      }

      const result = schema.safeParse(payload);
      if (result.success) {
        return { success: true, data: result.data };
      }

      return { success: false, error: result.error };
    },

    get(event: string): z.ZodType | undefined {
      return schemas.get(event);
    },

    has(event: string): boolean {
      return schemas.has(event);
    },

    keys(): IterableIterator<string> {
      return schemas.keys();
    },

    get size(): number {
      return schemas.size;
    },
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Validate a payload against the registry and apply the selected validation
 * mode. Returns Zod-transformed data on success.
 */
export function validateEventPayload(
  event: string,
  payload: unknown,
  registry: EventSchemaRegistry | undefined,
  mode: ValidationMode,
  logger?: Logger,
): unknown {
  if (mode === 'off' || !registry) return payload;

  const result = registry.validate(event, payload);
  if (result.success) {
    return result.data;
  }

  const message = `[EventSchemaRegistry] validation failed for event "${event}":\n${formatIssues(result.error)}`;
  if (mode === 'strict') {
    throw new Error(message, { cause: result.error });
  }

  (logger ?? noopLogger).warn(message);
  return payload;
}
