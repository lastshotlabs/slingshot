// packages/slingshot-auth/src/index.ts — Public API for @lastshotlabs/slingshot-auth

// Plugin factory
/** Build the auth plugin that mounts Slingshot's identity, session, and account-security surface. */
export { createAuthPlugin } from './plugin';
/** Zod schema for validating `createAuthPlugin()` configuration. */
export { authPluginConfigSchema } from './types/config';
/** Public config types accepted by `createAuthPlugin()` and related auth builders. */
export type {
  AccountDeletionConfig,
  AuthPluginConfig,
  AuthDbConfig,
  AuthSecurityConfig,
  AuthConfig,
  AuthCookieConfig,
  AuthRateLimitConfig,
  AuthSessionPolicyConfig,
  BreachedPasswordConfig,
  ConcealRegistrationConfig,
  CsrfCookieConfig,
  EmailVerificationConfig,
  JwtConfig,
  MagicLinkConfig,
  MfaConfig,
  MfaEmailOtpConfig,
  MfaWebAuthnConfig,
  OAuthConfig,
  OidcConfig,
  PasswordResetConfig,
  PrimaryField,
  RefreshTokenConfig,
  SamlConfig,
  ScimConfig,
  StepUpConfig,
} from './types/config';

// Session / JWT
/** Sign and verify Slingshot auth JWTs using the configured signing policy. */
export { signToken, verifyToken } from './lib/jwt';
/** Session repository helpers and adapters used by Slingshot auth runtime flows. */
export {
  createSession,
  getSession,
  deleteSession,
  getUserSessions,
  getActiveSessionCount,
  evictOldestSession,
  updateSessionLastActive,
  setRefreshToken,
  getSessionByRefreshToken,
  rotateRefreshToken,
  getSessionFingerprint,
  setSessionFingerprint,
  setMfaVerifiedAt,
  getMfaVerifiedAt,
  sessionFactories,
  createSqliteSessionRepository,
  createRedisSessionRepository,
  createMongoSessionRepository,
} from './lib/session/index.js';
// Note: deleteUserSessions bypasses security events and hooks — use the
// route handlers or runtime.repos.session directly for mass revocation.
// createMemorySessionRepository and SessionRepository are available from
// @lastshotlabs/slingshot-auth/testing for test setup.
// Adapter capability validator
/** Validate that an auth adapter implements the capabilities required by the current config. */
export { validateAdapterCapabilities } from './lib/validateAdapter';
export type { AdapterValidationConfig } from './lib/validateAdapter';

// Built-in adapters
/** In-process and database-backed auth adapter factories for first-party deployments. */
export { createMemoryAuthAdapter } from './adapters/memoryAuth';
export type { MemoryAuthStores } from './adapters/memoryAuth';
/** Mongo-backed auth adapter factory for production deployments using Mongo persistence. */
export { createMongoAuthAdapter } from './adapters/mongoAuth';
/** Mongoose model factory for the auth user collection. */
export { createAuthUserModel } from './models/AuthUser';
/** SQLite-backed auth adapter factory for embedded or single-node deployments. */
export { createSqliteAuthAdapter } from './adapters/sqliteAuth';
/** SQLite cache adapter used by framework boundary adapters. */
export { createSqliteCacheAdapter } from './lib/cache';

// Email templates
/** Built-in auth email template renderer and template registry. */
export { renderTemplate, templates } from './lib/emailTemplates';
export type { EmailTemplate, TemplateVariables } from './lib/emailTemplates';

// Config
/** Resolve raw auth config into the normalized runtime config used during boot. */
export { createAuthResolvedConfig } from './config/authConfig';
export type {
  AuthResolvedConfig,
  HookContext,
} from './config/authConfig';

// Event bus utilities
/** Security event wiring contracts for audit and alerting integrations. */
export type { SecurityEventsConfig, SecurityEvent } from './lib/securityEventWiring';

// Runtime context
/** Read the auth runtime that the plugin stores in Slingshot context and request state. */
export {
  getAuthRuntimeContext,
  getAuthRuntimeContextOrNull,
  getAuthRuntimeFromRequest,
} from './runtime';
/** Instance-scoped auth runtime shape published by `createAuthPlugin()`. */
export type { AuthRuntimeContext } from './runtime';

// Middleware (exported for use by dependent plugins)
/** Request guards for authenticated-user routes and role-gated routes. */
export { userAuth } from './middleware/userAuth';
export { requireRole } from './middleware/requireRole';
/** Shared error-response schema used by built-in auth handlers. */
export { ErrorResponse } from './schemas/error';

// OAuth state utilities (useful for consumers building custom OAuth flows)
/** Generate PKCE and OAuth state values for custom OAuth flows outside the built-in routes. */
export { generateCodeVerifier, generateState } from './lib/oauth';

// Admin providers (moved from framework root)
/** Admin integration adapters backed by Slingshot auth runtime state. */
export { createSlingshotAuthAccessProvider } from './admin/slingshotAccess';
export { createSlingshotManagedUserProvider } from './admin/slingshotUsers';
