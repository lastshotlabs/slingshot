/**
 * Public contract for `slingshot-emoji`.
 *
 * Provider-owned contract slot used by cross-package consumers. The package
 * does not currently expose runtime capabilities; the contract is declared
 * here so future entity or capability publication has a stable home.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';

/** Provider-owned package contract for `slingshot-emoji`. */
export const Emoji = definePackageContract('slingshot-emoji');
