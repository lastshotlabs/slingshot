/**
 * Minimal CRUD contract for a resolved entity runtime adapter.
 *
 * This shape is transport-agnostic and intentionally lives in `slingshot-core`
 * so the instance-scoped `SlingshotContext` can expose resolved entity
 * adapters without depending on `slingshot-entity`.
 */
import type { EntityWriteOptions } from './entityConfig';
import type { FilterExpression } from './operations';

export interface EntityCrudAdapter {
  create(data: unknown): Promise<unknown>;
  getById(id: string, filter?: Record<string, unknown>): Promise<unknown>;
  list(opts: {
    filter?: FilterExpression;
    limit?: number;
    cursor?: string;
    sortDir?: 'asc' | 'desc';
    /** Include records hidden by the entity's soft-delete policy. */
    includeDeleted?: boolean;
  }): Promise<{ items: unknown[]; cursor?: string; nextCursor?: string; hasMore?: boolean }>;
  update(
    id: string,
    data: unknown,
    filter?: Record<string, unknown>,
    options?: EntityWriteOptions,
  ): Promise<unknown>;
  delete(
    id: string,
    filter?: Record<string, unknown>,
    options?: EntityWriteOptions,
  ): Promise<boolean>;
}

/**
 * Full runtime adapter surface for one entity.
 *
 * CRUD methods are always present; named operation methods are attached as
 * additional function properties at runtime.
 */
export type EntityRuntimeAdapter = EntityCrudAdapter & { [key: string]: unknown };
