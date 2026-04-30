import { SlingshotError } from '@lastshotlabs/slingshot-core';

/** Thrown when search plugin configuration is invalid. */
export class SearchConfigError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_CONFIG_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchConfigError';
  }
}

/** Thrown for duplicate or unknown transform handlers. */
export class SearchTransformError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_TRANSFORM_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchTransformError';
  }
}

/** Thrown for operations on non-existent search indexes. */
export class SearchIndexNotFoundError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_INDEX_NOT_FOUND', `[slingshot-search] ${message}`);
    this.name = 'SearchIndexNotFoundError';
  }
}

/** Thrown for provider-level failures. */
export class SearchProviderError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_PROVIDER_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchProviderError';
  }
}

/** Thrown for unsupported filter operators. */
export class SearchFilterError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_FILTER_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchFilterError';
  }
}

/** Thrown for pagination errors (e.g. offset limits exceeded). */
export class SearchPaginationError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_PAGINATION_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchPaginationError';
  }
}

/** Thrown for validation failures on search inputs. */
export class SearchValidationError extends SlingshotError {
  constructor(message: string) {
    super('SEARCH_VALIDATION_ERROR', `[slingshot-search] ${message}`);
    this.name = 'SearchValidationError';
  }
}
