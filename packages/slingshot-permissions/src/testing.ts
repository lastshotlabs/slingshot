// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-permissions/testing — Test utilities
// ---------------------------------------------------------------------------

export { createMemoryPermissionsAdapter } from './adapters/memory';
export type { PermissionsMemoryAdapter } from './adapters/memory';
/**
 * Audit trail test utilities.
 */
export { createMemoryAuditTrailStore } from './lib/auditTrail';
export type {
  AuditTrailEntry,
  AuditTrailFilter,
  AuditTrailStore,
  MemoryAuditTrailStoreOptions,
} from './lib/auditTrail';
