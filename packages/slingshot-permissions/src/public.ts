/**
 * Public contract for `slingshot-permissions`.
 *
 * The plugin publishes three typed capabilities at boot:
 *
 *   - `PermissionsEvaluatorCap` — answers `can()` queries
 *   - `PermissionsRegistryCap` — resource-type registry for role → action mappings
 *   - `PermissionsAdapterCap` — persistence adapter for grants
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

/** Provider-owned package contract for `slingshot-permissions`. */
export const Permissions = definePackageContract('slingshot-permissions');

/** Capability handle for the permission evaluator (answers `can()` queries). */
export const PermissionsEvaluatorCap = Permissions.capability<PermissionEvaluator>('evaluator');
/** Capability handle for the permission registry (resource-type → role/action mappings). */
export const PermissionsRegistryCap = Permissions.capability<PermissionRegistry>('registry');
/** Capability handle for the persistence adapter that backs grant storage. */
export const PermissionsAdapterCap = Permissions.capability<PermissionsAdapter>('adapter');
