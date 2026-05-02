/**
 * field.*() builder API for entity field definitions.
 */
import type {
  FieldDef,
  FieldOptions,
  FieldType,
  ResolveDflt,
  ResolveInputVariants,
  ResolveOpt,
  ResolveUpd,
} from '../types';

function makeField<
  T extends FieldType,
  O extends FieldOptions | undefined,
  EV extends readonly string[] = readonly string[],
>(
  type: T,
  opts?: O,
  enumValues?: EV,
): FieldDef<T, ResolveOpt<O>, ResolveDflt<O>, ResolveUpd<O>, EV, ResolveInputVariants<O>> {
  const result: FieldDef<
    T,
    ResolveOpt<O>,
    ResolveDflt<O>,
    ResolveUpd<O>,
    EV,
    ResolveInputVariants<O>
  > = {
    type,
    optional: (opts?.optional ?? false) as ResolveOpt<O>,
    primary: opts?.primary ?? false,
    immutable: opts?.immutable ?? opts?.primary ?? false,
    private: opts?.private ?? false,
    inputVariants: opts?.inputVariants as ResolveInputVariants<O>,
    format: opts?.format,
    default: opts?.default as ResolveDflt<O>,
    onUpdate: opts?.onUpdate as ResolveUpd<O>,
    enumValues,
  };
  return result;
}

/**
 * Fluent builder namespace for entity field definitions.
 *
 * Each method returns a frozen `FieldDef` object describing the field's type
 * and constraints. Pass the result directly into the `fields` record of
 * `defineEntity()`.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-entity';
 *
 * const User = defineEntity('User', {
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     email:     field.string(),
 *     age:       field.integer({ optional: true }),
 *     score:     field.number({ default: 0 }),
 *     active:    field.boolean({ default: true }),
 *     role:      field.enum(['admin', 'member', 'guest']),
 *     metadata:  field.json({ optional: true }),
 *     tags:      field.stringArray({ optional: true }),
 *     createdAt: field.date({ default: 'now' }),
 *     month:     field.string({ format: 'month' }),
 *   },
 * });
 * ```
 *
 * @remarks
 * - `field.string({ primary: true })` implicitly sets `immutable: true`.
 * - `field.enum()` requires a `values` array as its first argument. The
 *   allowed values are embedded in the generated TypeScript union type.
 * - `field.date({ onUpdate: 'now' })` automatically updates the field to the
 *   current timestamp on every write (equivalent to `updated_at` columns).
 */
export const field = {
  /**
   * A UTF-8 string field.
   *
   * @param opts - Optional field options (`primary`, `optional`, `format`, `default`, `immutable`).
   * @returns A `FieldDef<'string'>`.
   *
   * @example
   * ```ts
   * field.string({ primary: true, default: 'uuid' }) // UUID primary key
   * field.string({ optional: true })                  // nullable string
   * field.string({ format: 'email' })                 // validated email address
   * ```
   */
  string: <const O extends FieldOptions | undefined = undefined>(opts?: O) =>
    makeField('string', opts),

  /**
   * A floating-point number field.
   *
   * Maps to `REAL` in SQLite, `DOUBLE PRECISION` in Postgres, and `Number` in
   * Mongo/memory. Use `field.integer()` for whole-number fields.
   *
   * @param opts - Optional field options.
   * @returns A `FieldDef<'number'>`.
   *
   * @example
   * ```ts
   * field.number({ default: 0.0 })
   * ```
   */
  number: <const O extends FieldOptions | undefined = undefined>(opts?: O) =>
    makeField('number', opts),

  /**
   * A whole-number (integer) field.
   *
   * Maps to `INTEGER` in SQLite/Postgres and `Number` (integer) in
   * Mongo/memory. Unlike `field.number()`, generated TypeScript types use
   * `number` but adapters enforce integer semantics where possible.
   *
   * @param opts - Optional field options.
   * @returns A `FieldDef<'integer'>`.
   *
   * @example
   * ```ts
   * field.integer({ default: 0 })
   * ```
   */
  integer: <const O extends FieldOptions | undefined = undefined>(opts?: O) =>
    makeField('integer', opts),

  /**
   * A boolean field.
   *
   * Maps to `INTEGER` (0/1) in SQLite, `BOOLEAN` in Postgres, and a native
   * boolean in Mongo/memory.
   *
   * @param opts - Optional field options.
   * @returns A `FieldDef<'boolean'>`.
   *
   * @example
   * ```ts
   * field.boolean({ default: true })
   * ```
   */
  boolean: <const O extends FieldOptions | undefined = undefined>(opts?: O) =>
    makeField('boolean', opts),

  /**
   * A date/timestamp field.
   *
   * Maps to `TEXT` (ISO 8601) in SQLite, `TIMESTAMPTZ` in Postgres, and `Date`
   * in Mongo/memory.
   *
   * @param opts - Optional field options. Supports `default: 'now'` and
   *   `onUpdate: 'now'` for automatic timestamp management.
   * @returns A `FieldDef<'date'>`.
   *
   * @example
   * ```ts
   * field.date({ default: 'now' })              // created_at
   * field.date({ default: 'now', onUpdate: 'now' }) // updated_at
   * ```
   */
  date: <const O extends FieldOptions | undefined = undefined>(opts?: O) => makeField('date', opts),

  /**
   * An enumerated string field.
   *
   * The `values` array is embedded in the generated TypeScript union type and
   * validated at runtime. Maps to `TEXT` with a CHECK constraint in SQLite, an
   * `ENUM` type in Postgres, and a plain string in Mongo/memory.
   *
   * @param values - The exhaustive set of allowed string values.
   * @param opts - Optional field options.
   * @returns A `FieldDef<'enum'>` with `enumValues` set.
   *
   * @example
   * ```ts
   * field.enum(['draft', 'published', 'archived'] as const)
   * ```
   */
  enum: <const V extends readonly string[], const O extends FieldOptions | undefined = undefined>(
    values: V,
    opts?: O,
  ) => makeField('enum', opts, values),

  /**
   * An arbitrary JSON field.
   *
   * Maps to `JSONB` in Postgres, `TEXT` (JSON-serialized) in SQLite, and a
   * plain object in Mongo/memory. The generated TypeScript type is `unknown`.
   *
   * @param opts - Optional field options.
   * @returns A `FieldDef<'json'>`.
   *
   * @example
   * ```ts
   * field.json({ optional: true }) // metadata?: unknown
   * ```
   */
  json: <const O extends FieldOptions | undefined = undefined>(opts?: O) => makeField('json', opts),

  /**
   * An array-of-strings field.
   *
   * Maps to `TEXT` (JSON-serialized array) in SQLite, `TEXT[]` in Postgres,
   * and a native array in Mongo/memory. The generated TypeScript type is
   * `string[]`.
   *
   * @param opts - Optional field options.
   * @returns A `FieldDef<'string[]'>`.
   *
   * @example
   * ```ts
   * field.stringArray({ optional: true }) // tags?: string[]
   * ```
   */
  stringArray: <const O extends FieldOptions | undefined = undefined>(opts?: O) =>
    makeField('string[]', opts),
} as const;
