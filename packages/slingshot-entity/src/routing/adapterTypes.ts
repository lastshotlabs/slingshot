/**
 * The typed CRUD surface of a bare entity adapter.
 *
 * Each method mirrors the HTTP verb and semantics used by the generated routes.
 */
export interface BareEntityAdapterCrud {
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
 * A full entity adapter: typed CRUD methods plus a dynamic index for named
 * operation methods (for example `adapter.byRoom(input)`).
 */
export type BareEntityAdapter = BareEntityAdapterCrud & { [key: string]: unknown };
