// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-search/errors — Error classes
// ---------------------------------------------------------------------------

export { SearchCircuitOpenError } from './searchCircuitBreaker';
export { ProviderUnavailableError } from './providers/typesense';
export {
  SearchConfigError,
  SearchTransformError,
  SearchIndexNotFoundError,
  SearchProviderError,
  SearchFilterError,
  SearchPaginationError,
  SearchValidationError,
} from './errors/searchErrors';
