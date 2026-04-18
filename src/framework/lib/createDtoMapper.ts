import { z } from 'zod';

type ZodObjectShape = Record<string, z.ZodType>;
type ZodObjectLike<TOutput extends Record<string, unknown>> = z.ZodType<TOutput> & {
  shape: ZodObjectShape;
};
type Stringifiable = { toString(): string };
type IsoStringifiable = { toISOString(): string };
type DtoSource = Record<string, unknown> & { _id?: Stringifiable };

function isNullable(schema: z.ZodType): boolean {
  let current: unknown = schema;
  while (current instanceof z.ZodDefault) {
    current = current.unwrap();
  }
  return current instanceof z.ZodNullable || current instanceof z.ZodOptional;
}

function isStringifiable(value: unknown): value is Stringifiable {
  return typeof value === 'object' && value !== null && 'toString' in value;
}

function isIsoStringifiable(value: unknown): value is IsoStringifiable {
  return typeof value === 'object' && value !== null && 'toISOString' in value;
}

function toId(value: unknown, field: string): string {
  if (!isStringifiable(value)) {
    throw new TypeError(`[createDtoMapper] Expected "${field}" to be stringifiable`);
  }
  return value.toString();
}

function toIsoString(value: unknown, field: string): string {
  if (!isIsoStringifiable(value)) {
    throw new TypeError(`[createDtoMapper] Expected "${field}" to provide toISOString()`);
  }
  return value.toISOString();
}

export type DtoMapperConfig = {
  /** DB field name -> API field name for ObjectId refs (e.g., { account: "accountId" }) */
  refs?: Record<string, string>;
  /** API field names that are Date in DB, string in DTO */
  dates?: string[];
  /** Subdocument array fields mapped with a sub-mapper: { items: itemMapper } */
  subdocs?: Record<string, (item: unknown) => unknown>;
};

/**
 * Create a toDto mapper function from a Zod schema.
 *
 * The Zod schema defines which fields exist in the DTO. The config declares
 * how to transform DB-specific types (ObjectId refs, Dates, subdocuments).
 *
 * Handles automatically:
 * - `_id` -> `id` (toString)
 * - ObjectId refs -> string (toString), with field renaming via `refs`
 * - Date fields -> ISO string via `dates`
 * - Subdocument arrays via `subdocs`
 * - Nullable/optional fields -> `null` coercion (from `undefined`)
 * - All other fields -> passthrough
 */
export function createDtoMapper<TDto extends Record<string, unknown> = Record<string, unknown>>(
  zodSchema: ZodObjectLike<TDto>,
  config: DtoMapperConfig = {},
): (doc: DtoSource) => TDto {
  const apiFields = Object.keys(zodSchema.shape);
  const shape = zodSchema.shape;

  const refByApiField = new Map<string, string>();
  if (config.refs) {
    for (const [dbField, apiField] of Object.entries(config.refs)) {
      refByApiField.set(apiField, dbField);
    }
  }

  const dateSet = new Set(config.dates ?? []);

  return (doc: DtoSource): TDto => {
    const dto: Record<string, unknown> = {};

    for (const field of apiFields) {
      if (field === 'id') {
        dto.id = toId(doc._id, '_id');
        continue;
      }

      const refField = refByApiField.get(field);
      if (refField) {
        dto[field] = toId(doc[refField], refField);
        continue;
      }

      if (dateSet.has(field)) {
        dto[field] = toIsoString(doc[field], field);
        continue;
      }

      const subdocMapper = config.subdocs?.[field];
      if (subdocMapper) {
        const items = Array.isArray(doc[field]) ? doc[field] : [];
        dto[field] = items.map(item => subdocMapper(item));
        continue;
      }

      const fieldSchema = shape[field];
      const value = doc[field];
      dto[field] = isNullable(fieldSchema) ? (value ?? null) : value;
    }

    return dto as TDto;
  };
}
