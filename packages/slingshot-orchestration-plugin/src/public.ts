/**
 * Public contract for `slingshot-orchestration-plugin`.
 *
 * Cross-plugin consumers fetch the orchestration runtime through the typed
 * `OrchestrationRuntimeCap` capability:
 *
 * ```ts
 * import { OrchestrationRuntimeCap } from '@lastshotlabs/slingshot-orchestration-plugin';
 * const runtime = ctx.capabilities.require(OrchestrationRuntimeCap);
 * ```
 *
 * The legacy `getOrchestration(ctx)` / `getOrchestrationOrNull(ctx)` helpers remain as
 * thin wrappers around the contract resolution path for back-compat with documented
 * examples.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { OrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';

export const Orchestration = definePackageContract('slingshot-orchestration');

/** Typed capability handle resolving to the orchestration runtime. */
export const OrchestrationRuntimeCap =
  Orchestration.capability<OrchestrationRuntime>('runtime');
