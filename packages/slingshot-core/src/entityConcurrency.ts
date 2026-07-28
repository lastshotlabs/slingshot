import { SlingshotError } from './errors';

/** Raised when a concurrency-enabled write requires an expected version but none was supplied. */
export class EntityConcurrencyPreconditionError extends SlingshotError {
  override readonly name = 'EntityConcurrencyPreconditionError';
  declare readonly code: 'ENTITY_CONCURRENCY_PRECONDITION_REQUIRED';

  constructor(
    readonly entity: string,
    readonly operation: 'update' | 'delete',
  ) {
    super(
      'ENTITY_CONCURRENCY_PRECONDITION_REQUIRED',
      `${operation} on "${entity}" requires an expected version`,
    );
  }
}

/** Raised when an entity changed after the caller read its expected version. */
export class EntityConcurrencyConflictError extends SlingshotError {
  override readonly name = 'EntityConcurrencyConflictError';
  declare readonly code: 'ENTITY_CONCURRENCY_CONFLICT';

  constructor(
    readonly entity: string,
    readonly id: string | number,
    readonly expectedVersion: number,
  ) {
    super(
      'ENTITY_CONCURRENCY_CONFLICT',
      `Concurrent ${entity} write conflicted for id "${String(id)}"`,
    );
  }
}
