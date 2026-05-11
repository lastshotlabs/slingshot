/**
 * Public contract for `slingshot-search`.
 *
 * Cross-package consumers resolve `SearchRuntimeCap` through `ctx.capabilities.require(...)`
 * to ensure config entities are indexed and to retrieve typed search clients.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { SearchPluginRuntime } from '@lastshotlabs/slingshot-core';

/** Provider-owned package contract for `slingshot-search`. */
export const Search = definePackageContract('slingshot-search');

/**
 * Capability handle for the search plugin runtime.
 *
 * Cross-package consumers resolve it through `ctx.capabilities.require(SearchRuntimeCap)`
 * to retrieve typed search clients and ensure config entities are indexed.
 */
export const SearchRuntimeCap = Search.capability<SearchPluginRuntime>('runtime');
