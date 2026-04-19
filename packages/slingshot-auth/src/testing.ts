// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-auth/testing — Test utilities
//
// All state is now per-instance (factory pattern). Create fresh instances
// in each test — no global clear functions needed.
// ---------------------------------------------------------------------------

export { createMemoryAuthAdapter } from './adapters/memoryAuth';
export type { MemoryAuthStores } from './adapters/memoryAuth';
export {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from './lib/authRateLimit';
export type { AuthRateLimitService, AuthRateLimitRepository } from './lib/authRateLimit';
export { createLockoutService } from './lib/accountLockout';
export { createMemoryLockoutRepository } from './lib/accountLockout';
export type { LockoutService, LockoutRepository } from './lib/accountLockout';
export {
  createCredentialStuffingService,
  createMemoryCredentialStuffingRepository,
} from './lib/credentialStuffing';
export type {
  CredentialStuffingService,
  CredentialStuffingRepository,
} from './lib/credentialStuffing';

// Repository factories for test setup
export { createMemoryMfaChallengeRepository } from './lib/mfaChallenge';
export type { MfaChallengeRepository } from './lib/mfaChallenge';
export { createMemorySamlRequestIdRepository } from './lib/samlRequestId';
export type { SamlRequestIdRepository } from './lib/samlRequestId';
export { createMemoryOAuthCodeRepository } from './lib/oauthCode';
export type { OAuthCodeRepository } from './lib/oauthCode';
export { createMemoryOAuthReauthRepository } from './lib/oauthReauth';
export type { OAuthReauthRepository } from './lib/oauthReauth';
export { createMemoryOAuthStateStore } from './lib/oauth';
export type { OAuthStateStore } from './lib/oauth';
export { createMemoryMagicLinkRepository } from './lib/magicLink';
export type { MagicLinkRepository } from './lib/magicLink';
export { createMemoryDeletionCancelTokenRepository } from './lib/deletionCancelToken';
export type { DeletionCancelTokenRepository } from './lib/deletionCancelToken';
export { createMemoryVerificationTokenRepository } from './lib/emailVerification';
export type { VerificationTokenRepository } from './lib/emailVerification';
export { createMemoryResetTokenRepository } from './lib/resetPassword';
export type { ResetTokenRepository } from './lib/resetPassword';
export { createMemorySessionRepository } from './lib/session/index.js';
export type { SessionRepository } from './lib/session/index.js';
export { resolveRepo } from '@lastshotlabs/slingshot-core';
export type { StoreInfra, RepoFactories } from '@lastshotlabs/slingshot-core';

// Runtime context key — needed to inject the auth runtime into Hono context in tests
export { AUTH_RUNTIME_KEY } from './runtime';
// Test helper to pre-compute a dummy password hash, avoiding bcrypt on every test run
export { makeDummyHashGetter } from './services/auth';
