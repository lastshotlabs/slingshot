/**
 * Field type tokens and definition interfaces.
 */

/**
 * The set of scalar field types supported by slingshot-entity.
 *
 * These tokens drive TypeScript type inference in generated code and control
 * how each backend maps the field to its native column/document type.
 *
 * @remarks
 * - `'integer'` is distinct from `'number'` — backends map it to an integral
 *   column type (e.g. `INTEGER` in SQLite/Postgres, plain `Number` in Mongo).
 * - `'json'` maps to `JSONB` in Postgres, `TEXT` (JSON-serialized) in SQLite,
 *   and a plain embedded object in Mongo/memory.
 * - `'string[]'` maps to a JSON array column in SQL backends and an array
 *   field in Mongo/memory.
 * - `'enum'` requires a companion `enumValues` array on the field definition.
 *
 * @example
 * ```ts
 * import type { FieldType } from '@lastshotlabs/slingshot-entity';
 *
 * function describeField(type: FieldType): string {
 *   return `Field is of type: ${type}`;
 * }
 * describeField('string');  // 'Field is of type: string'
 * describeField('integer'); // 'Field is of type: integer'
 * ```
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'json'
  | 'string[]';

/**
 * Sentinel values that instruct slingshot to generate a default at write time
 * rather than storing a literal.
 *
 * - `'uuid'` — generate a random UUID v4 (string fields only).
 * - `'cuid'` — generate a CUID (string fields only).
 * - `'now'` — use the current timestamp (date fields only).
 *
 * @example
 * ```ts
 * import { field } from '@lastshotlabs/slingshot-entity';
 * import type { AutoDefault } from '@lastshotlabs/slingshot-entity';
 *
 * const autoDefaults: AutoDefault[] = ['uuid', 'cuid', 'now'];
 *
 * // Used as the default value for a field:
 * const idField = field.string({ primary: true, default: 'uuid' });
 * const createdAtField = field.date({ default: 'now' });
 * ```
 */
export type AutoDefault = 'uuid' | 'now' | 'cuid';

/**
 * Options accepted by the `field.*()` builder functions.
 *
 * All options are optional; the builder applies sensible defaults.
 *
 * @remarks
 * Setting `primary: true` implicitly sets `immutable: true` unless `immutable`
 * is explicitly provided as `false`.
 *
 * @example
 * ```ts
 * import { field } from '@lastshotlabs/slingshot-entity';
 * import type { FieldOptions } from '@lastshotlabs/slingshot-entity';
 *
 * const opts: FieldOptions = {
 *   primary: true,
 *   default: 'uuid',
 *   immutable: true,
 * };
 * const idField = field.string(opts);
 * ```
 */
export interface FieldOptions {
  /** When true the field is not required on create. Defaults to `false`. */
  optional?: boolean;
  /**
   * JSON Schema / OpenAPI string format for string fields.
   *
   * Common values include `email`, `uri`, `uuid`, `date`, `date-time`, `time`,
   * `month`, and `color`. The generator preserves this metadata in the emitted
   * OpenAPI schema so form generators can render the right control.
   */
  format?: string;
  /**
   * Static default value or auto-default sentinel written on create when the
   * caller omits the field. Use `'uuid'` or `'cuid'` for string PKs, `'now'`
   * for timestamp fields.
   */
  default?: string | number | boolean;
  /**
   * When `'now'`, the field is automatically updated to the current timestamp
   * on every write. Only valid for `date` fields.
   */
  onUpdate?: 'now';
  /**
   * When true this field is the entity's primary key. Exactly one field per
   * entity must be marked primary.
   */
  primary?: boolean;
  /**
   * When true the field cannot be changed after the record is created.
   * Defaults to `true` for primary key fields.
   */
  immutable?: boolean;
}

type ResolveOpt<O> = O extends { optional: true }
  ? true
  : O extends undefined
    ? false
    : O extends { optional?: false | undefined }
      ? false
      : boolean;

type ResolveDflt<O> = O extends { default: infer D extends string | number | boolean }
  ? D
  : undefined;

type ResolveUpd<O> = O extends { onUpdate: 'now' } ? 'now' : undefined;

/**
 * The resolved, frozen description of a single entity field.
 *
 * Produced by the `field.*()` builders and stored inside `EntityConfig.fields`.
 * All properties are `readonly` — mutating a field definition after
 * `defineEntity()` is called is not supported.
 *
 * @typeParam T - The concrete `FieldType` for this field. Inferred from the
 *   builder call; rarely needs to be specified manually.
 *
 * @example
 * ```ts
 * import { field } from '@lastshotlabs/slingshot-entity';
 *
 * const idField: FieldDef<'string'> = field.string({ primary: true, default: 'uuid' });
 * ```
 */
export interface FieldDef<
  T extends FieldType = FieldType,
  IsOptional extends boolean = boolean,
  Default extends string | number | boolean | undefined = string | number | boolean | undefined,
  OnUpdate extends 'now' | undefined = 'now' | undefined,
  EnumValues extends readonly string[] = readonly string[],
> {
  readonly type: T;
  readonly optional: IsOptional;
  readonly primary: boolean;
  readonly immutable: boolean;
  readonly format?: string;
  readonly default?: Default;
  readonly onUpdate?: OnUpdate;
  /** Allowed values for `type === 'enum'` fields. */
  readonly enumValues?: EnumValues;
}

export type { ResolveDflt, ResolveOpt, ResolveUpd };
