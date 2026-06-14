/**
 * Public contract for `slingshot-permissions`.
 *
 * The package publishes four typed capabilities at boot:
 *
 *   - `PermissionsEvaluatorCap` — answers `can()` queries
 *   - `PermissionsRegistryCap` — resource-type registry for role → action mappings
 *   - `PermissionsAdapterCap` — persistence adapter for grants
 *   - `PermissionsHealthCap` — aggregated health snapshot
 *
 * Cross-package consumers resolve them via `ctx.capabilities.require(...)` instead of
 * reaching into `PERMISSIONS_RUNTIME_KEY` directly.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type {
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import type { EvaluatorHealth } from './lib/evaluator';

/**
 * Aggregated health snapshot for `slingshot-permissions`. Returned by the
 * `PermissionsHealthCap` capability.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when no permissions adapter has been resolved yet (the
 *     package hasn't completed `setupMiddleware`, or another package pre-seeded
 *     state without an adapter).
 *   - `'degraded'` when the evaluator has observed any query timeouts or
 *     group-expansion errors since startup, or when the backing adapter
 *     reports a disconnected state.
 *   - `'healthy'` otherwise.
 */
export interface PermissionsHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /** `true` when a `PermissionsAdapter` has been resolved into plugin state. */
    readonly adapterAvailable: boolean;
    /** Adapter implementation name (best-effort). `null` when unavailable. */
    readonly adapterName: string | null;
    /** Per-evaluator counters surfaced from the most recently created evaluator. */
    readonly evaluator: EvaluatorHealth | null;
    /**
     * Adapter-level health snapshot. Present when the backing adapter
     * exposes a `healthCheck()` method (currently the Postgres adapter).
     * `undefined` for adapters that do not support health checks (memory,
     * SQLite).
     */
    readonly adapter:
      | {
          readonly status: 'connected' | 'disconnected';
        }
      | undefined;
    /** Unix timestamp (ms) of the last adapter health check. `undefined` if never checked. */
    readonly adapterHealthLastChecked: number | undefined;
  };
}

/** Provider-owned package contract for `slingshot-permissions`. */
export const Permissions = definePackageContract('slingshot-permissions');

/** Capability handle for the permission evaluator (answers `can()` queries). */
export const PermissionsEvaluatorCap = Permissions.capability<PermissionEvaluator>('evaluator');
/** Capability handle for the permission registry (resource-type → role/action mappings). */
export const PermissionsRegistryCap = Permissions.capability<PermissionRegistry>('registry');
/** Capability handle for the persistence adapter that backs grant storage. */
export const PermissionsAdapterCap = Permissions.capability<PermissionsAdapter>('adapter');
/**
 * Capability for reading the aggregated permissions health snapshot.
 *
 * Consumers resolve via `ctx.capabilities.require(PermissionsHealthCap)()` and
 * receive a `PermissionsHealth` representing adapter, evaluator, and
 * adapter-level connectivity state at call time.
 */
export const PermissionsHealthCap = Permissions.capability<() => PermissionsHealth>('health');
