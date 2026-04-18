/**
 * index() and relation builders for entity definitions.
 */
import type { IndexDef, RelationDef } from '../types';

/**
 * Declare a database index on one or more entity fields.
 *
 * The returned `IndexDef` is passed into `EntityConfig.indexes`. Each backend
 * adapter generates the appropriate DDL or index creation statement during
 * schema initialisation.
 *
 * @param fields - Field names to include in the index (in order). All names
 *   must reference fields that exist in the entity definition.
 * @param opts - Optional index options.
 * @param opts.direction - Sort direction for all columns in the index.
 *   Defaults to `'asc'`.
 * @param opts.unique - When true a unique constraint is enforced. Equivalent
 *   to adding an entry to `EntityConfig.uniques`.
 * @returns An `IndexDef` object suitable for use in `EntityConfig.indexes`.
 *
 * @example
 * ```ts
 * import { defineEntity, field, index } from '@lastshotlabs/slingshot-entity';
 *
 * const Post = defineEntity('Post', {
 *   fields: {
 *     id:        field.string({ primary: true, default: 'uuid' }),
 *     authorId:  field.string(),
 *     createdAt: field.date({ default: 'now' }),
 *   },
 *   indexes: [
 *     index(['authorId', 'createdAt'], { direction: 'desc' }),
 *   ],
 * });
 * ```
 */
export function index(
  fields: string[],
  opts?: { direction?: 'asc' | 'desc'; unique?: boolean },
): IndexDef {
  return { fields, direction: opts?.direction, unique: opts?.unique };
}

/**
 * Fluent builder namespace for entity relation definitions.
 *
 * Relations are informational: they drive TypeScript type generation but do
 * not create foreign-key constraints in the database. Use them together with
 * indexes for query performance.
 *
 * @example
 * ```ts
 * import { defineEntity, field, relation } from '@lastshotlabs/slingshot-entity';
 *
 * const Comment = defineEntity('Comment', {
 *   fields: {
 *     id:     field.string({ primary: true, default: 'uuid' }),
 *     postId: field.string(),
 *     userId: field.string(),
 *   },
 *   relations: {
 *     post: relation.belongsTo('Post', 'postId'),
 *     author: relation.belongsTo('User', 'userId', { optional: false }),
 *   },
 * });
 * ```
 */
export const relation = {
  /**
   * Declares that this entity holds a foreign key pointing to another entity.
   *
   * @param target - Name of the referenced entity (must match its
   *   `defineEntity()` name exactly).
   * @param foreignKey - Field on **this** entity that stores the foreign key.
   * @param opts - Optional options.
   * @param opts.optional - When true the foreign key field may be null.
   * @returns A `RelationDef` with `kind: 'belongsTo'`.
   *
   * @example
   * ```ts
   * relation.belongsTo('User', 'authorId')
   * relation.belongsTo('Organization', 'orgId', { optional: true })
   * ```
   */
  belongsTo: (target: string, foreignKey: string, opts?: { optional?: boolean }): RelationDef => ({
    kind: 'belongsTo',
    target,
    foreignKey,
    optional: opts?.optional,
  }),

  /**
   * Declares that another entity holds a foreign key pointing to this one (1:N).
   *
   * @param target - Name of the child entity.
   * @param foreignKey - Field on the **child** entity that references this
   *   entity's primary key.
   * @returns A `RelationDef` with `kind: 'hasMany'`.
   *
   * @example
   * ```ts
   * relation.hasMany('Comment', 'postId')
   * ```
   */
  hasMany: (target: string, foreignKey: string): RelationDef => ({
    kind: 'hasMany',
    target,
    foreignKey,
  }),

  /**
   * Declares that exactly one other entity holds a foreign key pointing to this
   * one (1:1 from the other side).
   *
   * @param target - Name of the child entity.
   * @param foreignKey - Field on the **child** entity that references this
   *   entity's primary key.
   * @returns A `RelationDef` with `kind: 'hasOne'`.
   *
   * @example
   * ```ts
   * relation.hasOne('UserProfile', 'userId')
   * ```
   */
  hasOne: (target: string, foreignKey: string): RelationDef => ({
    kind: 'hasOne',
    target,
    foreignKey,
  }),
} as const;
