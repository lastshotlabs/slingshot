// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-admin/testing — Test utilities
//
// Provides in-memory implementations of AdminAccessProvider and
// ManagedUserProvider so tests can exercise admin routes without a real
// auth backend (Auth0, slingshot-auth, etc.).
//
// Create fresh instances per test — all state is closure-private.
// ---------------------------------------------------------------------------

export {
  createMemoryAccessProvider,
  createMemoryManagedUserProvider,
} from './providers/memoryAccess';
export type { MemoryManagedUserProvider } from './providers/memoryAccess';
