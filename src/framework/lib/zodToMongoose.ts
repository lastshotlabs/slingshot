import { getMongooseModule } from '@lib/mongo';
import type { Schema as SchemaType } from 'mongoose';
import { z } from 'zod';

type ZodObjectShape = Record<string, z.ZodType>;
type ZodObjectLike = { shape: ZodObjectShape };

function unwrap(zodType: z.ZodType): { core: unknown; required: boolean } {
  let current: unknown = zodType;
  let required = true;

  while (
    current instanceof z.ZodNullable ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap();
    required = false;
  }

  return { core: current, required };
}

/** Lazily access the Mongoose Schema class (avoids top-level require of mongoose) */
function getSchema() {
  return getMongooseModule().Schema;
}

/** Convert a single Zod type to a Mongoose field definition */
function toMongooseField(zodType: z.ZodType): Record<string, unknown> {
  const { core, required } = unwrap(zodType);

  if (core instanceof z.ZodString) return { type: String, required };
  if (core instanceof z.ZodNumber) return { type: Number, required };
  if (core instanceof z.ZodBoolean) return { type: Boolean, required };
  if (core instanceof z.ZodDate) return { type: Date, required };
  if (core instanceof z.ZodEnum) return { type: String, enum: core.options, required };

  return { type: getSchema().Types.Mixed, required };
}

export type ZodToMongooseRefConfig = {
  /** DB field name (e.g., "account") */
  dbField: string;
  /** Referenced model name (e.g., "Account") */
  ref: string;
};

export type ZodToMongooseConfig = {
  /** DB-only fields not in the Zod schema (e.g., user ref) */
  dbFields?: Record<string, unknown>;
  /** API fields that map to ObjectId refs: { accountId: { dbField: "account", ref: "Account" } } */
  refs?: Record<string, ZodToMongooseRefConfig>;
  /** Override Mongoose type for specific fields (e.g., { date: { type: Date, required: true } }) */
  typeOverrides?: Record<string, unknown>;
  /** Subdocument array fields: { items: mongooseSubSchema } */
  subdocSchemas?: Record<string, SchemaType>;
};

/**
 * Derive a Mongoose SchemaDefinition from a Zod object schema.
 *
 * Business fields are auto-converted from Zod types to Mongoose types.
 * DB-specific concerns (ObjectId refs, type overrides, subdocuments) are declared via config.
 *
 * The `id` field is automatically excluded (Mongoose provides `_id`).
 */
export function zodToMongoose(
  zodSchema: ZodObjectLike,
  config: ZodToMongooseConfig = {},
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const [apiField, zodType] of Object.entries(zodSchema.shape)) {
    if (apiField === 'id') continue;

    const refConfig = config.refs?.[apiField];
    if (refConfig) {
      fields[refConfig.dbField] = {
        type: getSchema().Types.ObjectId,
        ref: refConfig.ref,
        required: true,
      };
      continue;
    }

    const typeOverride = config.typeOverrides?.[apiField];
    if (typeOverride) {
      fields[apiField] = typeOverride;
      continue;
    }

    const subdocSchema = config.subdocSchemas?.[apiField];
    if (subdocSchema) {
      fields[apiField] = [subdocSchema];
      continue;
    }

    fields[apiField] = toMongooseField(zodType);
  }

  if (config.dbFields) {
    Object.assign(fields, config.dbFields);
  }

  return fields;
}
