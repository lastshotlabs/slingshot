/**
 * Public contract for `slingshot-assets`.
 *
 * Cross-package consumers resolve capabilities through `ctx.capabilities.require(...)`:
 *
 *   - `AssetsRuntimeCap` — bundled assets adapter, storage adapter, and config.
 *   - `AssetsHealthCap`  — aggregated health snapshot getter.
 *   - `AssetsOrphanedKeysCap` — recovery-API snapshot of orphaned storage keys.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { AssetsHealth, AssetsPluginState, OrphanedKeyRecord } from './types';

/** Provider-owned package contract for `slingshot-assets`. */
export const Assets = definePackageContract('slingshot-assets');

/**
 * Capability handle for the assets plugin runtime.
 *
 * Cross-package consumers resolve it through `ctx.capabilities.require(AssetsRuntimeCap)`
 * to fetch the bundled assets adapter, storage adapter, and resolved config.
 */
export const AssetsRuntimeCap = Assets.capability<AssetsPluginState>('runtime');

/**
 * Capability for reading the aggregated assets health snapshot.
 *
 * Consumers resolve via `ctx.capabilities.require(AssetsHealthCap)()` and
 * receive an {@link AssetsHealth} reflecting storage adapter, S3 circuit
 * breaker, and image cache state at call time.
 */
export const AssetsHealthCap = Assets.capability<() => AssetsHealth>('health');

/**
 * Capability for the orphaned-storage recovery API.
 *
 * Consumers resolve via `ctx.capabilities.require(AssetsOrphanedKeysCap)(since?)`
 * and receive a snapshot of {@link OrphanedKeyRecord}s the delete-cascade
 * middleware has accumulated since startup (or since the optional cutoff). The
 * list is bounded in memory; durable retention is the operator's responsibility
 * via `onOrphanedKey`.
 */
export const AssetsOrphanedKeysCap =
  Assets.capability<(since?: Date) => ReadonlyArray<OrphanedKeyRecord>>('orphanedKeys');
