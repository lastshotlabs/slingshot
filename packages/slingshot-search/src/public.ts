/**
 * Public contract for `slingshot-search`.
 *
 * Cross-package consumers resolve `SearchRuntimeCap` through `ctx.capabilities.require(...)`
 * to ensure config entities are indexed and to retrieve typed search clients.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { SearchPluginRuntime } from '@lastshotlabs/slingshot-core';

export const Search = definePackageContract('slingshot-search');

export const SearchRuntimeCap = Search.capability<SearchPluginRuntime>('runtime');
