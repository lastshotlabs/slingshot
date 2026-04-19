/**
 * Minimal CRUD contract for a resolved entity runtime adapter.
 *
 * This shape is transport-agnostic and intentionally lives in `slingshot-core`
 * so the instance-scoped `SlingshotContext` can expose resolved entity
 * adapters without depending on `slingshot-entity`.
 */
export interface EntityCrudAdapter {
  create(data: unknown): Promise<unknown>;
  getById(id: string, filter?: Record<string, unknown>): Promise<unknown>;
  list(opts: {
    filter?: unknown;
    limit?: number;
    cursor?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<{ items: unknown[]; cursor?: string; nextCursor?: string; hasMore?: boolean }>;
  update(id: string, data: unknown, filter?: Record<string, unknown>): Promise<unknown>;
  delete(id: string, filter?: Record<string, unknown>): Promise<boolean>;
}

/**
 * Full runtime adapter surface for one entity.
 *
 * CRUD methods are always present; named operation methods are attached as
 * additional function properties at runtime.
 */
export type EntityRuntimeAdapter = EntityCrudAdapter & { [key: string]: unknown };
