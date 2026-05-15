/**
 * Public contract for `slingshot-polls`.
 *
 * Cross-package consumers resolve `PollsRuntimeCap` through
 * `ctx.capabilities.require(...)` to read the active polls runtime
 * (poll/vote adapters, sweep handle). The legacy plugin-state slot at
 * `POLLS_RUNTIME_KEY` is still published in parallel during the bridge period.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { PollsPluginState } from './types';

/** Provider-owned package contract for `slingshot-polls`. */
export const Polls = definePackageContract('slingshot-polls');

/**
 * Capability handle for the polls runtime state.
 *
 * Cross-package consumers resolve it via
 * `ctx.capabilities.require(PollsRuntimeCap)`. The legacy `POLLS_RUNTIME_KEY`
 * plugin-state slot is still published in parallel during the bridge period;
 * new consumers should prefer the cap.
 */
export const PollsRuntimeCap = Polls.capability<PollsPluginState>('runtime');
