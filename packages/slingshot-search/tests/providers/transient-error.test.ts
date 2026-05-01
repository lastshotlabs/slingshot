/**
 * Provider-specific `isTransientError` tests.
 *
 * Exercises the exported `isTransientError` functions from the Algolia and
 * Meilisearch provider modules to ensure they correctly classify transient
 * vs. non-transient errors for their respective backends.
 */
import { describe, expect, it } from 'bun:test';
import { isTransientError as algoliaIsTransient } from '../../src/providers/algolia';
import { isTransientError as meiliIsTransient } from '../../src/providers/meilisearch';

describe('Algolia isTransientError', () => {
  it('returns false for non-Error objects', () => {
    expect(algoliaIsTransient('string error')).toBe(false);
    expect(algoliaIsTransient(42)).toBe(false);
    expect(algoliaIsTransient(null)).toBe(false);
    expect(algoliaIsTransient(undefined)).toBe(false);
  });

  it('returns true for timeout errors', () => {
    expect(algoliaIsTransient(new Error('Connection timed out'))).toBe(true);
    expect(algoliaIsTransient(new Error('request timeout'))).toBe(true);
  });

  it('returns true for connection-refused errors', () => {
    expect(algoliaIsTransient(new Error('ECONNREFUSED'))).toBe(true);
    expect(algoliaIsTransient(new Error('Connection refused'))).toBe(true);
  });

  it('returns true for connection-reset errors', () => {
    expect(algoliaIsTransient(new Error('ECONNRESET'))).toBe(true);
    expect(algoliaIsTransient(new Error('socket hang up'))).toBe(true);
  });

  it('returns true for DNS resolution errors', () => {
    expect(algoliaIsTransient(new Error('EAI_AGAIN'))).toBe(true);
    expect(algoliaIsTransient(new Error('ENOTFOUND'))).toBe(true);
    expect(algoliaIsTransient(new Error('ENXIO'))).toBe(true);
  });

  it('returns true for HTTP 429 and 5xx status codes', () => {
    expect(algoliaIsTransient(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(algoliaIsTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(algoliaIsTransient(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(algoliaIsTransient(new Error('HTTP 504 Gateway Timeout'))).toBe(true);
  });

  it('returns true for 408 timeout', () => {
    expect(algoliaIsTransient(new Error('HTTP 408 Request Timeout'))).toBe(true);
  });

  it('returns true for service-unavailable messages', () => {
    expect(algoliaIsTransient(new Error('Service Unavailable'))).toBe(true);
    expect(algoliaIsTransient(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns true for Algolia-specific temporarily/retry messages', () => {
    expect(algoliaIsTransient(new Error('[slingshot-search:algolia] temporarily unavailable'))).toBe(
      true,
    );
    expect(algoliaIsTransient(new Error('[slingshot-search:algolia] please retry later'))).toBe(
      true,
    );
  });

  it('returns false for non-transient 4xx errors', () => {
    expect(algoliaIsTransient(new Error('HTTP 400 Bad Request'))).toBe(false);
    expect(algoliaIsTransient(new Error('HTTP 401 Unauthorized'))).toBe(false);
    expect(algoliaIsTransient(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(algoliaIsTransient(new Error('HTTP 404 Not Found'))).toBe(false);
    expect(algoliaIsTransient(new Error('HTTP 409 Conflict'))).toBe(false);
    expect(algoliaIsTransient(new Error('HTTP 422 Unprocessable'))).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(algoliaIsTransient(new Error('Invalid API key'))).toBe(false);
    expect(algoliaIsTransient(new Error('Object not found'))).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(algoliaIsTransient(new Error('TIMEOUT'))).toBe(true);
    expect(algoliaIsTransient(new Error('Connection REFUSED'))).toBe(true);
    expect(algoliaIsTransient(new Error('Too Many Requests'))).toBe(true);
  });
});

describe('Meilisearch isTransientError', () => {
  it('returns false for non-Error objects', () => {
    expect(meiliIsTransient('string error')).toBe(false);
    expect(meiliIsTransient(42)).toBe(false);
    expect(meiliIsTransient(null)).toBe(false);
    expect(meiliIsTransient(undefined)).toBe(false);
  });

  it('returns true for timeout errors', () => {
    expect(meiliIsTransient(new Error('Connection timed out'))).toBe(true);
    expect(meiliIsTransient(new Error('request timeout'))).toBe(true);
  });

  it('returns true for connection-refused errors', () => {
    expect(meiliIsTransient(new Error('ECONNREFUSED'))).toBe(true);
    expect(meiliIsTransient(new Error('Connection refused'))).toBe(true);
  });

  it('returns true for connection-reset errors', () => {
    expect(meiliIsTransient(new Error('ECONNRESET'))).toBe(true);
    expect(meiliIsTransient(new Error('socket hang up'))).toBe(true);
  });

  it('returns true for DNS resolution errors', () => {
    expect(meiliIsTransient(new Error('EAI_AGAIN'))).toBe(true);
    expect(meiliIsTransient(new Error('ENOTFOUND'))).toBe(true);
    expect(meiliIsTransient(new Error('ENXIO'))).toBe(true);
  });

  it('returns true for HTTP 429 and 5xx status codes', () => {
    expect(meiliIsTransient(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(meiliIsTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(meiliIsTransient(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(meiliIsTransient(new Error('HTTP 504 Gateway Timeout'))).toBe(true);
  });

  it('returns true for 408 timeout', () => {
    expect(meiliIsTransient(new Error('HTTP 408 Request Timeout'))).toBe(true);
  });

  it('returns true for service-unavailable messages', () => {
    expect(meiliIsTransient(new Error('Service Unavailable'))).toBe(true);
    expect(meiliIsTransient(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns true for Meilisearch-specific transient messages', () => {
    expect(
      meiliIsTransient(new Error('[slingshot-search:meilisearch] temporarily unavailable')),
    ).toBe(true);
    expect(meiliIsTransient(new Error('[slingshot-search:meilisearch] please retry'))).toBe(true);
    expect(meiliIsTransient(new Error('[slingshot-search:meilisearch] internal error'))).toBe(true);
  });

  it('returns false for non-transient 4xx errors', () => {
    expect(meiliIsTransient(new Error('HTTP 400 Bad Request'))).toBe(false);
    expect(meiliIsTransient(new Error('HTTP 401 Unauthorized'))).toBe(false);
    expect(meiliIsTransient(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(meiliIsTransient(new Error('HTTP 404 Not Found'))).toBe(false);
    expect(meiliIsTransient(new Error('HTTP 409 Conflict'))).toBe(false);
    expect(meiliIsTransient(new Error('HTTP 422 Unprocessable'))).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(meiliIsTransient(new Error('Invalid API key'))).toBe(false);
    expect(meiliIsTransient(new Error('Index not found'))).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(meiliIsTransient(new Error('TIMEOUT'))).toBe(true);
    expect(meiliIsTransient(new Error('Connection REFUSED'))).toBe(true);
    expect(meiliIsTransient(new Error('Too Many Requests'))).toBe(true);
  });
});
