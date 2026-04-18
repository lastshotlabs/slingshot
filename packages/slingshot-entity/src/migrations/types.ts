/**
 * Schema migration types.
 */
import type {
  FieldDef,
  FieldType,
  IndexDef,
  PaginationConfig,
  ResolvedEntityConfig,
  SoftDeleteConfig,
} from '../types';

/**
 * A single detected change between two entity config snapshots.
 *
 * Produced by `diffEntityConfig()` and consumed by the per-backend migration
 * generators (`generateMigrationSqlite`, `generateMigrationPostgres`,
 * `generateMigrationMongo`).
 *
 * The discriminated union covers all change types that affect the physical
 * schema:
 * - `addField` / `removeField` — column additions/removals.
 * - `changeFieldType` — column type change (breaking — emitted as a warning
 *   comment, not a live ALTER statement, for safety).
 * - `addIndex` / `removeIndex` — index creation/deletion.
 * - `addUnique` / `removeUnique` — unique constraint creation/deletion.
 * - `changeSoftDelete` — soft-delete config added, removed, or changed.
 * - `changePagination` — pagination config changed (informational only,
 *   no DDL emitted).
 *
 * @example
 * ```ts
 * import { diffEntityConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const plan = diffEntityConfig(previousConfig, currentConfig);
 * for (const change of plan.changes) {
 *   switch (change.type) {
 *     case 'addField':    console.log('Added field:', change.name); break;
 *     case 'removeField': console.log('Removed field:', change.name); break;
 *     case 'addIndex':    console.log('New index on:', change.index.fields); break;
 *   }
 * }
 * ```
 */
export type MigrationChange =
  | { readonly type: 'addField'; readonly name: string; readonly field: FieldDef }
  | { readonly type: 'removeField'; readonly name: string; readonly field: FieldDef }
  | {
      readonly type: 'changeFieldType';
      readonly name: string;
      readonly from: FieldType;
      readonly to: FieldType;
    }
  | { readonly type: 'addIndex'; readonly index: IndexDef }
  | { readonly type: 'removeIndex'; readonly index: IndexDef }
  | { readonly type: 'addUnique'; readonly unique: { readonly fields: readonly string[] } }
  | { readonly type: 'removeUnique'; readonly unique: { readonly fields: readonly string[] } }
  | {
      readonly type: 'changeSoftDelete';
      readonly from: SoftDeleteConfig | undefined;
      readonly to: SoftDeleteConfig | undefined;
    }
  | {
      readonly type: 'changePagination';
      readonly from: PaginationConfig | undefined;
      readonly to: PaginationConfig | undefined;
    };

/**
 * Per-backend table/collection names resolved from the current entity's
 * `storage` config (falling back to `_storageName`).
 *
 * Embedded in `MigrationPlan` and used by the backend-specific migration
 * generators so their DDL output references the same physical table/collection
 * name as the runtime adapter in `generators/{sqlite,postgres,mongo}.ts`.
 *
 * @example
 * ```ts
 * import type { MigrationStorageNames } from '@lastshotlabs/slingshot-entity';
 *
 * // Accessed via MigrationPlan.storageNames after calling diffEntityConfig():
 * const plan = diffEntityConfig(previousConfig, currentConfig);
 * console.log(plan.storageNames.sqlite);   // e.g. 'chat_messages'
 * console.log(plan.storageNames.postgres); // e.g. 'chat_messages'
 * console.log(plan.storageNames.mongo);    // e.g. 'chat_messages'
 * ```
 */
export interface MigrationStorageNames {
  /** SQLite table name. */
  readonly sqlite: string;
  /** PostgreSQL table name. */
  readonly postgres: string;
  /** MongoDB collection name. */
  readonly mongo: string;
}

/**
 * The complete migration plan produced by `diffEntityConfig()`.
 *
 * Passed to the backend-specific generators to emit DDL/script files.
 * `hasBreakingChanges` is true when any `changeFieldType` change was detected.
 * `warnings` are human-readable notes included as comments in generated files.
 *
 * @example
 * ```ts
 * import { diffEntityConfig, generateMigrationSqlite } from '@lastshotlabs/slingshot-entity';
 *
 * const plan = diffEntityConfig(previousConfig, currentConfig);
 * if (plan.hasBreakingChanges) {
 *   console.warn('Breaking schema changes:', plan.warnings);
 * }
 * const sql = generateMigrationSqlite(plan);
 * ```
 */
export interface MigrationPlan {
  /** Entity name. */
  readonly entity: string;
  readonly namespace?: string;
  /** The `_storageName` of the current (new) entity config. */
  readonly storageName: string;
  /** Per-backend table/collection names derived from the current config's `storage` hints. */
  readonly storageNames: MigrationStorageNames;
  /** Ordered list of schema changes. Removals are emitted before additions. */
  readonly changes: readonly MigrationChange[];
  /** True when at least one `changeFieldType` change is present. */
  readonly hasBreakingChanges: boolean;
  /** Human-readable warnings included as comments in generated migration files. */
  readonly warnings: readonly string[];
}

/**
 * A persisted snapshot of an entity config at a point in time.
 *
 * Written to disk by `saveSnapshot()` and read back by `loadSnapshot()`.
 * The `entity` field is the full `ResolvedEntityConfig` serialized as JSON.
 *
 * @example
 * ```ts
 * import { loadSnapshot } from '@lastshotlabs/slingshot-entity';
 * import type { EntitySnapshot } from '@lastshotlabs/slingshot-entity';
 *
 * const snapshot: EntitySnapshot | null = loadSnapshot('.slingshot/snapshots', MessageConfig);
 * if (snapshot) {
 *   console.log('Snapshot taken at:', snapshot.timestamp);
 *   console.log('PK field at snapshot time:', snapshot.entity._pkField);
 * }
 * ```
 */
export interface EntitySnapshot {
  /** Always `1` — reserved for future format changes. */
  readonly snapshotVersion: 1;
  /** ISO 8601 timestamp of when the snapshot was saved. */
  readonly timestamp: string;
  /** The full entity config captured at snapshot time. */
  readonly entity: ResolvedEntityConfig;
}
