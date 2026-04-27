// Auth-specific runtime configuration — single resolved config object.
// This is the auth package's own copy — no @lib/* or @shared/* imports.
import type {
  AuthAdapter,
  AuthUserAccessDecision,
  AuthUserAccessInput,
  CaptchaConfig,
} from '@lastshotlabs/slingshot-core';
import { deepFreeze } from '@lastshotlabs/slingshot-core';
import type { EmailTemplate } from '../lib/emailTemplates';
import type { SamlProfile } from '../types/saml';

// ---------------------------------------------------------------------------
// Type definitions — all config shape interfaces
// ---------------------------------------------------------------------------

/**
 * The primary identifier field for user accounts.
 *
 * Controls which field is used as the login identifier — email address, username,
 * or phone number. Defaults to `'email'`. Set via `AuthConfig.primaryField`.
 */
export type PrimaryField = 'email' | 'username' | 'phone';

/**
 * Configuration for concealing registration conflicts from potential attackers.
 *
 * When set, a registration attempt for an already-existing identifier returns a
 * success response (same shape as a new registration) instead of a conflict error.
 * This prevents user enumeration via the registration endpoint.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     concealRegistration: {
 *       onExistingAccount: async (identifier) => {
 *         await mailer.send({ to: identifier, subject: 'Duplicate registration attempt' });
 *       },
 *     },
 *   },
 * });
 */
export interface ConcealRegistrationConfig {
  /**
   * Called when a registration attempt is made for an email that already exists.
   * Use to notify the existing user (e.g. "Someone tried to register with your email").
   * Only valid when primaryField === "email" — startup throws otherwise.
   */
  onExistingAccount?: (identifier: string) => Promise<void>;
}

/**
 * Configuration for the email verification flow.
 *
 * When enabled, a verification token is emailed to the user after registration.
 * Set `required: true` to block login until the user verifies their email address.
 *
 * @example
 * createAuthPlugin({ auth: { emailVerification: { required: true, tokenExpiry: 3600 } } });
 */
export interface EmailVerificationConfig {
  /** Block login until email is verified. Defaults to false (soft gate — emailVerified returned in login response). */
  required?: boolean;
  /** Token time-to-live in seconds. Defaults to 86 400 (24 hours). */
  tokenExpiry?: number;
}

/**
 * Configuration for the password reset flow.
 *
 * When set on `AuthConfig.passwordReset`, the `POST /auth/forgot-password` and
 * `POST /auth/reset-password` routes are mounted. Requires `primaryField === 'email'`.
 *
 * @example
 * createAuthPlugin({ auth: { passwordReset: { tokenExpiry: 1800 } } });
 */
export interface PasswordResetConfig {
  /** Token time-to-live in seconds. Defaults to 3 600 (1 hour). */
  tokenExpiry?: number;
}

/**
 * Configuration for passwordless magic-link sign-in.
 *
 * When set, the `POST /auth/magic-link/send` and `POST /auth/magic-link/verify` routes
 * are mounted. A single-use link containing a time-limited token is emailed to the user.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     magicLink: { ttlSeconds: 600, linkBaseUrl: 'https://app.example.com/auth/magic' },
 *   },
 * });
 */
export interface MagicLinkConfig {
  /** Token time-to-live in seconds. Defaults to 900 (15 min). */
  ttlSeconds?: number;
  /** Base URL for the magic link (e.g. "https://app.com/auth/magic"). */
  linkBaseUrl?: string;
  /** Store backend for magic link tokens. Defaults to the sessions store. */
  store?: 'memory' | 'redis' | 'sqlite' | 'mongo';
}

/**
 * Password strength policy enforced during registration and password change.
 *
 * All constraints are optional and have conservative defaults. The `preventReuse`
 * field requires that the adapter implements `getPasswordHistory` and `addPasswordToHistory`.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     passwordPolicy: { minLength: 12, requireSpecial: true, preventReuse: 5 },
 *   },
 * });
 */
export interface PasswordPolicyConfig {
  /** Minimum password length. Defaults to 8. */
  minLength?: number;
  /** Require at least one letter (a-z or A-Z). Defaults to true. */
  requireLetter?: boolean;
  /** Require at least one digit (0-9). Defaults to true. */
  requireDigit?: boolean;
  /** Require at least one special character. Defaults to false. */
  requireSpecial?: boolean;
  /** Number of previous password hashes to remember. Prevents password reuse. Default: disabled (0). */
  preventReuse?: number;
}

/**
 * Cookie attributes for the HttpOnly session authentication cookie.
 *
 * `httpOnly` is always `true` and cannot be overridden — the auth cookie must never
 * be accessible to JavaScript. All other attributes can be tuned per-deployment.
 * Set via `AuthConfig.cookieConfig`.
 *
 * @remarks
 * In production, `secure` defaults to `true` (HTTPS-only). Override only when
 * your environment terminates TLS at a load balancer and does not forward HTTPS.
 */
export interface AuthCookieConfig {
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
  domain?: string;
  path?: string;
  /** Max age in seconds. Default: 604800 (7 days). */
  maxAge?: number;
  // NOTE: httpOnly is always true for auth cookies - not configurable
}

/**
 * Cookie attributes for the CSRF double-submit cookie.
 *
 * `httpOnly` is always `false` — JavaScript must be able to read this cookie to
 * set the `x-csrf-token` request header. Set via `AuthConfig.csrfCookieConfig`.
 *
 * @remarks
 * The CSRF cookie is signed with HMAC-SHA256 (server secret) so tampering is detectable.
 * The client must echo it back in the `x-csrf-token` header on every state-changing request.
 */
export interface CsrfCookieConfig {
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
  domain?: string;
  path?: string;
  /** Max age in seconds. Default: 31536000 (1 year). */
  maxAge?: number;
  // NOTE: httpOnly is always false for CSRF cookie (JS must read it) - not configurable
}

/**
 * Minimal session policy snapshot stored in the resolved auth config.
 *
 * A subset of `AuthSessionPolicyConfig` that is copied into `AuthResolvedConfig.sessionPolicy`
 * for use by middleware and session functions that only need the applied policy values.
 * Matches the shape of `AuthSessionPolicyConfig`.
 */
export interface SessionPolicySnapshot {
  maxSessions?: number;
  persistSessionMetadata?: boolean;
  includeInactiveSessions?: boolean;
  trackLastActive?: boolean;
  absoluteTimeout?: number;
  idleTimeout?: number;
  onPasswordChange?: 'revoke_others' | 'revoke_all_and_reissue' | 'none';
}

/**
 * Configuration for the sliding refresh token rotation flow.
 *
 * When set on `AuthConfig.refreshTokens`, the plugin issues a short-lived JWT access token
 * alongside a long-lived refresh token. Clients exchange expired access tokens for new
 * ones at `POST /auth/refresh`. Rotation is atomic — the old refresh token is archived
 * in a short grace window before invalidation.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000, rotationGraceSeconds: 10 },
 *   },
 * });
 */
export interface RefreshTokenConfig {
  /** Access token expiry in seconds. Default: 900 (15 min). */
  accessTokenExpiry?: number;
  /** Refresh token expiry in seconds. Default: 2_592_000 (30 days). */
  refreshTokenExpiry?: number;
  /** Grace window in seconds where the old refresh token still works after rotation.
   *  Prevents lockout when the client's network drops mid-refresh. Default: 30. */
  rotationGraceSeconds?: number;
}

/**
 * Configuration for email-based OTP as a second MFA factor.
 *
 * When set on `MfaConfig.emailOtp`, users can choose email OTP as their second factor
 * in addition to TOTP. The OTP code is emailed via the configured mail provider.
 *
 * @example
 * createAuthPlugin({ auth: { mfa: { emailOtp: { codeLength: 8 } } } });
 */
export interface MfaEmailOtpConfig {
  /** OTP code length. Default: 6. */
  codeLength?: number;
}

/**
 * Configuration for WebAuthn (FIDO2) as a second MFA factor.
 *
 * When set on `MfaConfig.webauthn`, the plugin mounts WebAuthn registration and
 * authentication routes. Requires the `@simplewebauthn/server` peer dependency.
 * Set `allowPasswordlessLogin: true` to additionally mount passkey first-factor routes.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     mfa: {
 *       webauthn: {
 *         rpId: 'example.com',
 *         origin: 'https://example.com',
 *         rpName: 'Acme',
 *       },
 *     },
 *   },
 * });
 */
export interface MfaWebAuthnConfig {
  /** Relying Party ID - typically the domain (e.g. "example.com"). Required. */
  rpId: string;
  /** Relying Party name shown in browser prompts. Defaults to app name. */
  rpName?: string;
  /** Expected origin(s) - full origin URL(s) like "https://example.com". Required. */
  origin: string | string[];
  /** Supported attestation conveyance preference. Default: "none". */
  attestationType?: 'none' | 'direct' | 'enterprise';
  /** Authenticator attachment preference. Default: undefined (allows both platform + cross-platform). */
  authenticatorAttachment?: 'platform' | 'cross-platform';
  /** User verification requirement. Default: "preferred". */
  userVerification?: 'required' | 'preferred' | 'discouraged';
  /** Timeout for ceremonies in milliseconds. Default: 60000 (60s). */
  timeout?: number;
  /** Reject authentication when sign count goes backward (cloned key detection). Default: true in production, false otherwise. */
  strictSignCount?: boolean;
  /** Allow passwordless (first-factor) passkey login. When true, mounts POST /auth/passkey/login-options and POST /auth/passkey/login. Default: false. */
  allowPasswordlessLogin?: boolean;
  /** When true (default), a verified passkey login satisfies MFA - no subsequent TOTP/OTP prompt even if the user has MFA enabled. Set false to require MFA after passkey login. */
  passkeyMfaBypass?: boolean;
}

/**
 * Multi-factor authentication configuration.
 *
 * When set on `AuthConfig.mfa`, the MFA routes are mounted (`/auth/mfa/...`). TOTP is
 * always available. Add `emailOtp` or `webauthn` for additional factor options.
 * Set `required: true` to enforce MFA setup before users can access non-auth endpoints.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     mfa: {
 *       issuer: 'Acme',
 *       emailOtp: { codeLength: 6 },
 *       required: false,
 *     },
 *   },
 * });
 */
export interface MfaConfig {
  /** Issuer name shown in authenticator apps. Defaults to app name. */
  issuer?: string;
  /** TOTP algorithm. Default: "SHA1" (most compatible). */
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
  /** TOTP digits. Default: 6. */
  digits?: number;
  /** TOTP period in seconds. Default: 30. */
  period?: number;
  /** Number of recovery codes to generate. Default: 10. */
  recoveryCodes?: number;
  /** MFA challenge window in seconds. Default: 300 (5 min). */
  challengeTtlSeconds?: number;
  /** Email OTP configuration. When set, enables email-based MFA as an option. */
  emailOtp?: MfaEmailOtpConfig;
  /** WebAuthn/FIDO2 configuration. When set, enables security key MFA routes. */
  webauthn?: MfaWebAuthnConfig;
  /** When true, authenticated users must complete MFA setup before accessing non-auth endpoints. Default: false. */
  required?: boolean;
}

/**
 * JWT signing configuration.
 *
 * Controls the algorithm, issuer, and audience claims added to all signed tokens.
 * When `algorithm` is `'RS256'`, the OIDC key pair is used for signing (requires
 * `auth.oidc` to be configured). Set via `AuthConfig.jwt`.
 *
 * @example
 * createAuthPlugin({
 *   auth: { jwt: { issuer: 'https://auth.example.com', audience: 'app-client' } },
 * });
 */
export interface JwtConfig {
  /** JWT issuer claim (`iss`). When set, added to all tokens and validated on verify. */
  issuer?: string;
  /** JWT audience claim (`aud`). When set, added to all tokens and validated on verify. */
  audience?: string | string[];
  /** JWT signing algorithm. Default: "HS256". Use "RS256" for OIDC. Requires OidcConfig when set to "RS256". */
  algorithm?: 'HS256' | 'RS256';
  /**
   * Clock skew tolerance in seconds for JWT verification.
   *
   * Distributed systems with minor clock drift may reject valid tokens without
   * tolerance. Set to `0` to disable. Default: `60` (one minute), matching Auth0's
   * default and the RFC 7519 recommendation to allow for "a few minutes."
   */
  clockTolerance?: number;
}

/**
 * Configuration for breached password detection via the HaveIBeenPwned API.
 *
 * When set on `AuthConfig.breachedPasswordCheck`, registration and password-reset
 * attempts are checked against the HIBP k-Anonymity API. Matching passwords can be
 * blocked or allowed based on `block` and `onApiFailure` policy.
 *
 * @example
 * createAuthPlugin({
 *   auth: { breachedPasswordCheck: { block: true, onApiFailure: 'allow', minBreachCount: 1 } },
 * });
 */
export interface BreachedPasswordConfig {
  /** Block registration/reset when password is breached. Default: true. */
  block?: boolean;
  /** Minimum breach count to consider breached. Default: 1. */
  minBreachCount?: number;
  /** Request timeout in ms. Default: 3000. */
  timeout?: number;
  /**
   * What to do when the HIBP API is unavailable (timeout, network error, non-2xx).
   * Default: `"allow"` (fail-open) — the password is accepted without a breach check.
   *
   * **Security note:** `"allow"` means an attacker who can block outbound HTTPS to
   * api.pwnedpasswords.com can bypass this check entirely. Set to `"block"` for
   * fail-closed behaviour: the registration or password-reset is rejected until the
   * API is reachable again. Either way, a `security.breached_password.api_failure`
   * event is emitted on every outage so you have observability regardless of policy.
   */
  onApiFailure?: 'allow' | 'block';
}

/**
 * Configuration for OAuth re-authentication flows.
 *
 * When enabled on `OAuthConfig.reauth`, the plugin mounts re-auth endpoints that force
 * the user to re-authenticate with their OAuth provider. Useful for high-security
 * operations that require a fresh credential proof.
 *
 * @example
 * createAuthPlugin({
 *   auth: { oauth: { reauth: { enabled: true, promptType: 'login' } } },
 * });
 */
export interface OAuthReauthConfig {
  /** Enable OAuth provider re-auth endpoints. Default: false. */
  enabled?: boolean;
  /**
   * How to force re-authentication at the provider.
   * - "login": force the user to re-enter credentials (default)
   * - "consent": force a full consent screen (useful for Google/Microsoft)
   * - "select_account": show account picker
   */
  promptType?: 'login' | 'consent' | 'select_account';
}

/**
 * Configuration for step-up authentication.
 *
 * When set on `AuthConfig.stepUp`, the `POST /auth/step-up` route is mounted. Routes
 * protected by step-up verification require the user to complete MFA within the last
 * `maxAge` seconds before proceeding.
 *
 * @example
 * createAuthPlugin({ auth: { stepUp: { maxAge: 300 } } });
 */
export interface StepUpConfig {
  /** Max age in seconds since last MFA verification. Default: 300 (5 min). */
  maxAge?: number;
}

/**
 * Machine-to-machine (M2M) client credential configuration.
 *
 * When enabled, the plugin mounts an OAuth 2.0 client_credentials token endpoint
 * (`POST /oauth/token`). M2M clients can request access tokens using their client ID
 * and secret. Requires that the adapter implements the M2M adapter methods.
 *
 * @example
 * createAuthPlugin({
 *   auth: { m2m: { enabled: true, tokenExpiry: 3600, scopes: ['read:data', 'write:data'] } },
 * });
 */
export interface M2MConfig {
  enabled?: boolean;
  /** Access token expiry in seconds. Default: 3600 (1 hour). */
  tokenExpiry?: number;
  /** Allowed scopes for M2M clients. */
  scopes?: string[];
}

/**
 * SAML 2.0 Service Provider configuration.
 *
 * When set on `AuthConfig.saml`, the plugin mounts SAML SP routes (`/auth/saml/...`).
 * The IdP metadata is required — provide either an XML string or a URL from which it
 * will be fetched at startup.
 *
 * @remarks
 * The SP signing key (`signingKey`/`signingCert`) is optional but strongly recommended
 * for production: without it, AuthnRequests are unsigned and assertions are not verified
 * beyond XML schema validation.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     saml: {
 *       entityId: 'https://app.example.com/auth/saml',
 *       acsUrl: 'https://app.example.com/auth/saml/acs',
 *       idpMetadata: process.env.SAML_IDP_METADATA!,
 *     },
 *   },
 * });
 */
export interface SamlConfig {
  /** Service Provider entity ID (e.g. "https://yourapp.com/auth/saml"). */
  entityId: string;
  /** Assertion Consumer Service URL. */
  acsUrl: string;
  /** IdP metadata - XML string or URL. */
  idpMetadata: string;
  /** SP signing private key PEM. Optional. */
  signingKey?: string;
  /** SP signing certificate PEM. Optional. */
  signingCert?: string;
  /** Map IdP attribute names to profile fields. */
  attributeMapping?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    groups?: string;
  };
  /** Custom user lookup/creation. When provided, takes precedence over findOrCreateByProvider. */
  onLogin?: (profile: SamlProfile) => Promise<{ userId: string }>;
  /** Where to redirect after successful SAML login. Default: "/". */
  postLoginRedirect?: string;
}

/**
 * OpenID Connect provider configuration.
 *
 * When enabled, slingshot-auth exposes a standards-compliant OIDC discovery document
 * at `/.well-known/openid-configuration` and signs JWTs with RS256. Requires `auth.jwt.algorithm`
 * to be set to `"RS256"`.
 *
 * If no `signingKey` is provided, an RSA key pair is auto-generated at startup
 * (not suitable for multi-instance deployments — provide a stable key for production).
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     jwt: { algorithm: 'RS256' },
 *     oidc: {
 *       enabled: true,
 *       issuer: 'https://auth.example.com',
 *       signingKey: { privateKey: process.env.OIDC_PRIVATE_KEY!, publicKey: process.env.OIDC_PUBLIC_KEY! },
 *     },
 *   },
 * });
 */
export interface OidcConfig {
  enabled?: boolean;
  /** JWT issuer - included in all tokens and OIDC discovery doc. Required. */
  issuer: string;
  /** RSA signing key. If not provided, a key pair is auto-generated on startup. */
  signingKey?: { privateKey: string; publicKey: string; kid?: string };
  /** Previous signing keys for rotation (verification only). */
  previousKeys?: Array<{ publicKey: string; kid?: string }>;
  /** Scopes advertised in the discovery document. Default: ["openid"]. */
  scopes?: string[];
  /** Token endpoint URL. Defaults to `${issuer}/oauth/token`. */
  tokenEndpoint?: string;
  /** Authorization endpoint URL. Defaults to `${issuer}/auth/oauth/authorize`. */
  authorizationEndpoint?: string;
}

/**
 * SCIM 2.0 provisioning endpoint configuration.
 *
 * When enabled, the plugin mounts a SCIM 2.0-compliant user provisioning endpoint
 * (`/scim/v2/Users`). SCIM allows identity providers (Okta, Azure AD, etc.) to
 * automatically create, update, and deprovision user accounts.
 *
 * @remarks
 * Requires the adapter to implement `getUser` for RFC 7644 §3.6 DELETE compliance.
 * The `bearerTokens` field is required — SCIM endpoints must be authenticated.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     scim: {
 *       enabled: true,
 *       bearerTokens: process.env.SCIM_BEARER_TOKEN!,
 *       onDeprovision: 'suspend',
 *     },
 *   },
 * });
 */
export interface ScimConfig {
  enabled?: boolean;
  /** Bearer token(s) for SCIM endpoint authentication. Required. */
  bearerTokens: string | string[];
  /** Username mapping strategy. Default: "email". */
  userMapping?: { userName?: 'email' | 'username' };
  /**
   * What to do when a user is deleted via SCIM. Default: `"suspend"`.
   *
   * @remarks
   * `"suspend"` requires adapters to implement `setSuspended`.
   * `"delete"` requires adapters to implement `deleteUser`.
   * A custom function may be used when deprovisioning is handled externally.
   */
  onDeprovision?: 'suspend' | 'delete' | ((userId: string) => Promise<void>);
}

/**
 * Overrides for the built-in auth email templates.
 *
 * Each field is a partial `EmailTemplate` — only the fields you provide are overridden;
 * the rest continue to use the built-in defaults. Set via `AuthPluginConfig.emailTemplates`.
 *
 * @example
 * createAuthPlugin({
 *   emailTemplates: {
 *     appName: 'Acme',
 *     emailVerification: { subject: 'Please confirm your Acme account' },
 *   },
 * });
 */
export interface EmailTemplatesConfig {
  /** App name used in all templates as {{appName}}. Falls back to the configured app name. */
  appName?: string;
  emailVerification?: Partial<EmailTemplate>;
  passwordReset?: Partial<EmailTemplate>;
  magicLink?: Partial<EmailTemplate>;
  emailOtp?: Partial<EmailTemplate>;
  welcomeEmail?: Partial<EmailTemplate>;
  accountDeletion?: Partial<EmailTemplate>;
  orgInvitation?: Partial<EmailTemplate>;
}

// ---------------------------------------------------------------------------
// Bearer auth config (type-only — no singleton)
// ---------------------------------------------------------------------------

/**
 * A named bearer token client for machine-to-machine or server-to-server auth.
 *
 * When the request presents this client's `token` in the `Authorization: Bearer` header,
 * the framework publishes an `'api-key'` `Actor` whose `id` is `clientId` for downstream
 * handlers (`getActor(c)`). Set `revoked: true` to soft-revoke a client without removing
 * it from config.
 */
export interface BearerAuthClient {
  /** Stable identifier for this API client. Becomes `actor.id` for matched requests. */
  clientId: string;
  /** The bearer token value. */
  token: string;
  /** Optional human-readable label (e.g. "CI/CD pipeline", "Mobile app"). */
  description?: string;
  /** When true, the token is rejected even if it matches. Soft-revoke without deletion. */
  revoked?: boolean;
}

/**
 * Bearer auth token config.
 * - string: single token (legacy, env-var driven)
 * - string[]: multiple tokens, no clientId tracking
 * - BearerAuthClient[]: named clients with revocation and clientId context
 */
export type BearerAuthConfig = string | string[] | BearerAuthClient[];

// ---------------------------------------------------------------------------
// Auth lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Request-scoped context passed to auth lifecycle hooks.
 *
 * Allows hooks to record security events with the originating IP, user-agent, and
 * request ID for audit trails. All fields are optional — hooks must handle absence
 * gracefully.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     hooks: {
 *       preLogin: async ({ identifier, ip, userAgent }) => {
 *         if (blocklist.includes(ip)) throw new Error('Blocked');
 *       },
 *     },
 *   },
 * });
 */
export interface HookContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Return value of the `postLogin` lifecycle hook.
 *
 * When a `postLogin` hook returns an object with `customClaims`, those claims are
 * injected into the JWT payload (after stripping reserved JOSE claims).
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     hooks: {
 *       postLogin: async ({ userId }) => {
 *         const plan = await billing.getPlan(userId);
 *         return { customClaims: { plan } };
 *       },
 *     },
 *   },
 * });
 */
export interface PostLoginResult {
  customClaims?: Record<string, unknown>;
}

/**
 * Input passed to `hooks.checkUserAccess`.
 *
 * Extends the cross-package access input with the resolved auth adapter and the
 * deep-frozen resolved auth config so applications can inspect additional
 * adapter-backed account state without relying on module-level globals.
 */
export interface UserAccessHookInput extends AuthUserAccessInput {
  adapter: AuthAdapter;
  config: AuthResolvedConfig;
}

/**
 * Lifecycle hooks for auth events.
 *
 * Each hook receives the relevant identifiers and a `HookContext` with request metadata.
 * Throwing inside a `pre*` hook aborts the operation and propagates the error to the caller.
 * `post*` hook errors are caught and logged (non-blocking).
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     hooks: {
 *       preRegister: async ({ identifier, ip }) => {
 *         if (blocklist.includes(ip)) throw new Error('Blocked IP');
 *       },
 *       postLogin: async ({ userId, sessionId }) => {
 *         await audit.log({ event: 'login', userId, sessionId });
 *       },
 *     },
 *   },
 * });
 */
export interface AuthHooksConfig {
  preRegister?: (data: { identifier: string } & HookContext) => Promise<void>;
  postRegister?: (data: { userId: string; identifier: string } & HookContext) => Promise<void>;
  /** Runs before any session-issuing login path, including password, OAuth, SAML, passkey, magic-link verify, and concealed verify-and-login. */
  preLogin?: (data: { identifier: string } & HookContext) => Promise<void>;
  postLogin?: (
    data: { userId: string; sessionId: string } & HookContext,
  ) => Promise<PostLoginResult | undefined>;
  prePasswordChange?: (data: { userId: string } & HookContext) => Promise<void>;
  postPasswordChange?: (data: { userId: string } & HookContext) => Promise<void>;
  /** Runs when an authenticated account-deletion request is accepted, before synchronous deletion or queued deletion scheduling. */
  preDeleteAccount?: (data: { userId: string } & HookContext) => Promise<void>;
  /** Runs after auth data is actually deleted, including queued worker execution. */
  postDeleteAccount?: (data: { userId: string } & HookContext) => Promise<void>;
  /**
   * Runs when framework-owned guards need to decide whether an authenticated
   * user may continue. Use this to layer application-specific account-state
   * checks on top of the built-in suspension and required-email-verification
   * rules without teaching slingshot-core about custom user fields.
   */
  checkUserAccess?: (
    data: UserAccessHookInput,
  ) => Promise<AuthUserAccessDecision | boolean | undefined>;
}

// ---------------------------------------------------------------------------
// Auth rate limit config (type-only — no singleton)
// ---------------------------------------------------------------------------

/**
 * Per-endpoint rate limiting configuration for auth routes.
 *
 * Each key corresponds to an auth route family. When omitted, a sensible built-in default
 * is used. Set `store: 'redis'` for multi-instance deployments so counters are shared
 * across all server processes.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     rateLimit: {
 *       login: { windowMs: 15 * 60 * 1000, max: 5 },
 *       register: { windowMs: 60 * 60 * 1000, max: 3 },
 *       store: 'redis',
 *     },
 *   },
 * });
 */
export interface AuthRateLimitConfig {
  /** Max login failures per window before the account is locked. Default: 10 per 15 min. */
  login?: { windowMs?: number; max?: number };
  /** Max registration attempts per IP per window. Default: 5 per hour. */
  register?: { windowMs?: number; max?: number };
  /** Max email verification attempts per IP per window. Default: 10 per 15 min. */
  verifyEmail?: { windowMs?: number; max?: number };
  /** Max resend-verification attempts per user per window. Default: 3 per hour. */
  resendVerification?: { windowMs?: number; max?: number };
  /** Max forgot-password requests per IP per window. Default: 5 per 15 min. */
  forgotPassword?: { windowMs?: number; max?: number };
  /** Max reset-password attempts per IP per window. Default: 10 per 15 min. */
  resetPassword?: { windowMs?: number; max?: number };
  /** Max account deletion attempts per user per window. Default: 3 per hour. */
  deleteAccount?: { windowMs?: number; max?: number };
  /** Max MFA verification attempts per IP per window. Default: 10 per 15 min. */
  mfaVerify?: { windowMs?: number; max?: number };
  /** Max email OTP initiation attempts per user per window. Default: 3 per 15 min. */
  mfaEmailOtpInitiate?: { windowMs?: number; max?: number };
  /** Max MFA email OTP resend attempts per IP per window. Default: 5 per minute. */
  mfaResend?: { windowMs?: number; max?: number };
  /** Max set-password (change password) attempts per user per window. Default: 5 per 15 min. */
  setPassword?: { windowMs?: number; max?: number };
  /** Max MFA disable attempts per user per window. Default: 5 per 15 min. */
  mfaDisable?: { windowMs?: number; max?: number };
  /** Max OAuth provider unlink attempts per user per window. Default: 5 per hour. */
  oauthUnlink?: { windowMs?: number; max?: number };
  /**
   * Store backend for auth rate limit counters.
   * Defaults to "redis" when Redis is enabled, otherwise "memory".
   * Use "redis" for multi-instance deployments so limits are shared across servers.
   */
  store?: 'memory' | 'redis';
  /** Credential stuffing detection. Tracks distinct accounts per IP and IPs per account. */
  credentialStuffing?: {
    maxAccountsPerIp?: { count: number; windowMs: number };
    maxIpsPerAccount?: { count: number; windowMs: number };
    onDetected?: (signal: { type: 'ip' | 'account'; key: string; count: number }) => void;
  };
}

// ---------------------------------------------------------------------------
// Account deletion config (type-only — no singleton)
// ---------------------------------------------------------------------------

/**
 * Account deletion policy configuration.
 *
 * Controls whether `DELETE /auth/me` is available and how deletion is executed.
 * Supports immediate deletion, queued deletion (with a grace period and cancel link),
 * and lifecycle hooks for pre/post deletion logic.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     accountDeletion: {
 *       queued: true,
 *       gracePeriod: 604800, // 7 days
 *       requirePasswordConfirmation: true,
 *       onBeforeDelete: async (userId) => {
 *         await billing.cancelSubscription(userId);
 *       },
 *     },
 *   },
 * });
 */
export interface AccountDeletionConfig {
  /** When present and false, disables the account deletion endpoint entirely. Default: true. */
  enabled?: boolean;
  /** Called immediately before auth data is deleted. For queued deletion this runs in the worker at execution time, not when scheduling is requested. Throw to abort. */
  onBeforeDelete?: (userId: string) => Promise<void>;
  /** Called after auth data is deleted. Runs at execution time — query current state, not a snapshot. */
  onAfterDelete?: (userId: string) => Promise<void>;
  /** When true, deletion is queued as a BullMQ job instead of running synchronously. Requires Redis + BullMQ. */
  queued?: boolean;
  /** Grace period in seconds before queued deletion executes. Default: 0 (immediate). */
  gracePeriod?: number;
  /**
   * When true, OAuth-only accounts (no password, no MFA) cannot delete their account via DELETE /auth/me
   * because there is no verifiable factor. They must set a password or enable MFA first.
   * When false (default), OAuth-only accounts can delete without verification.
   */
  requireVerification?: boolean;
  /**
   * When true, users must confirm their password before their account can be deleted.
   * Provides an extra safety layer against accidental or unauthorized deletion.
   */
  requirePasswordConfirmation?: boolean;
}

// ---------------------------------------------------------------------------
// Auth session policy config (type-only — no singleton)
// ---------------------------------------------------------------------------

/**
 * Session lifecycle and capacity policy configuration.
 *
 * Controls session limits, metadata persistence, idle/absolute timeouts, and what
 * happens to sessions on password change. Set via `AuthConfig.sessionPolicy`.
 *
 * @remarks
 * Setting `idleTimeout` automatically enables `trackLastActive`. The `onPasswordChange`
 * policy defaults to `'revoke_others'` — always revoke at minimum after a password change
 * to prevent session hijacking via old credentials.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     sessionPolicy: {
 *       maxSessions: 3,
 *       absoluteTimeout: 604800,
 *       idleTimeout: 1800,
 *       onPasswordChange: 'revoke_all_and_reissue',
 *     },
 *   },
 * });
 */
export interface AuthSessionPolicyConfig {
  /** Max simultaneous active sessions per user. Oldest is evicted when exceeded. Default: 6. */
  maxSessions?: number;
  /**
   * Retain session metadata (IP, user-agent, timestamps) after a session expires or is deleted.
   * Enables future novel-device/location detection. Default: true.
   */
  persistSessionMetadata?: boolean;
  /**
   * Include inactive (expired/deleted) sessions in GET /auth/sessions.
   * Only meaningful when persistSessionMetadata is true. Default: false.
   */
  includeInactiveSessions?: boolean;
  /**
   * Update lastActiveAt on every authenticated request.
   * Adds one DB write per auth'd request. Default: false.
   * Automatically enabled when idleTimeout is set.
   */
  trackLastActive?: boolean;
  /**
   * Absolute session TTL in seconds. Sessions expire this long after creation regardless of activity.
   * Default: 604800 (7 days). Also controls the auth cookie maxAge when not overridden by cookieConfig.
   */
  absoluteTimeout?: number;
  /**
   * Idle timeout in seconds. Sessions are revoked when lastActiveAt is older than this value.
   * Requires trackLastActive to be meaningful — automatically enables it when set.
   * Refresh token rotation counts as activity (rotateRefreshToken updates lastActiveAt).
   */
  idleTimeout?: number;
  /**
   * What to do with sessions after a successful password change via POST /auth/set-password.
   * - "revoke_others" (default): revoke all sessions except the current one
   * - "revoke_all_and_reissue": revoke all sessions, create a new session, return new token
   * - "none": do nothing (not recommended)
   */
  onPasswordChange?: 'revoke_others' | 'revoke_all_and_reissue' | 'none';
}

// ---------------------------------------------------------------------------
// Resolved auth config — single config object replacing all singletons
// ---------------------------------------------------------------------------

/**
 * Read-only, deep-frozen snapshot of all resolved auth configuration values.
 *
 * Built once during plugin bootstrap by `createAuthResolvedConfig`, then attached to
 * `AuthRuntimeContext` as `runtime.config`. Every field has a concrete default — no
 * optional properties. Consumers should read from `runtime.config` rather than keeping
 * their own copies of plugin config.
 *
 * @remarks
 * The object is deep-frozen at creation time. Any attempt to mutate it in strict mode
 * throws a `TypeError`. Internal defaults are provided by `DEFAULT_AUTH_CONFIG`.
 */
export interface AuthResolvedConfig {
  readonly appName: string;
  readonly appRoles: readonly string[];
  readonly defaultRole: string | null;
  readonly primaryField: PrimaryField;
  readonly concealRegistration: Readonly<ConcealRegistrationConfig> | null;
  readonly emailVerification: Readonly<EmailVerificationConfig> | null;
  readonly passwordReset: Readonly<PasswordResetConfig> | null;
  readonly magicLink: Readonly<MagicLinkConfig> | null;
  readonly passwordPolicy: Readonly<PasswordPolicyConfig>;
  readonly rateLimit: Readonly<AuthRateLimitConfig>;
  readonly authCookie: Readonly<AuthCookieConfig>;
  readonly csrfCookie: Readonly<CsrfCookieConfig>;
  readonly maxSessions: number;
  readonly persistSessionMetadata: boolean;
  readonly includeInactiveSessions: boolean;
  readonly trackLastActive: boolean;
  readonly sessionPolicy: Readonly<SessionPolicySnapshot>;
  readonly refreshToken: Readonly<RefreshTokenConfig> | null;
  readonly mfa: Readonly<MfaConfig> | null;
  readonly csrfEnabled: boolean;
  readonly jwt: Readonly<JwtConfig> | null;
  readonly breachedPassword: Readonly<BreachedPasswordConfig> | null;
  readonly oauthReauth: Readonly<OAuthReauthConfig> | null;
  readonly stepUp: Readonly<StepUpConfig> | null;
  readonly checkSuspensionOnIdentify: boolean;
  readonly captcha: Readonly<CaptchaConfig> | null;
  readonly m2m: Readonly<M2MConfig> | null;
  readonly saml: Readonly<SamlConfig> | null;
  readonly oidc: Readonly<OidcConfig> | null;
  readonly scim: Readonly<ScimConfig> | null;
  readonly emailTemplates: Readonly<EmailTemplatesConfig> | null;
  readonly hooks: Readonly<AuthHooksConfig>;
}

// ---------------------------------------------------------------------------
// Default config — immutable baseline
// ---------------------------------------------------------------------------

/**
 * The immutable baseline `AuthResolvedConfig` used when no overrides are provided.
 *
 * All fields have concrete defaults. This constant is the baseline merged by
 * `createAuthResolvedConfig`. It is `Object.freeze`-d but not deep-frozen —
 * use `createAuthResolvedConfig` to get a properly deep-frozen config object.
 *
 * @remarks
 * Direct usage of `DEFAULT_AUTH_CONFIG` is uncommon outside the auth package internals.
 * Prefer `createAuthResolvedConfig({})` to obtain a deep-frozen baseline config.
 */
export const DEFAULT_AUTH_CONFIG: AuthResolvedConfig = Object.freeze({
  appName: 'Core API',
  appRoles: [],
  defaultRole: null,
  primaryField: 'email',
  concealRegistration: {},
  emailVerification: null,
  passwordReset: null,
  magicLink: null,
  passwordPolicy: {},
  rateLimit: {},
  authCookie: {},
  csrfCookie: {},
  maxSessions: 6,
  persistSessionMetadata: true,
  includeInactiveSessions: false,
  trackLastActive: false,
  sessionPolicy: {},
  refreshToken: null,
  mfa: null,
  csrfEnabled: false,
  jwt: null,
  breachedPassword: null,
  oauthReauth: null,
  stepUp: null,
  checkSuspensionOnIdentify: true,
  captcha: null,
  m2m: null,
  saml: null,
  oidc: null,
  scim: null,
  emailTemplates: null,
  hooks: {},
});

/**
 * Builds a resolved auth config by merging partial overrides onto `DEFAULT_AUTH_CONFIG`.
 * The returned object is deep-frozen — mutations throw in strict mode.
 *
 * Called by `bootstrapAuth` to produce the singleton config attached to
 * `AuthRuntimeContext`. Exposed publicly so consumers and tests can construct
 * a resolved config without going through the full plugin bootstrap.
 *
 * @param overrides - Partial config values to merge on top of the defaults.
 * @returns A deep-frozen `AuthResolvedConfig`.
 *
 * @example
 * import { createAuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
 *
 * const config = createAuthResolvedConfig({
 *   appName: 'Acme',
 *   primaryField: 'email',
 *   maxSessions: 3,
 *   refreshToken: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },
 * });
 */
export function createAuthResolvedConfig(
  overrides: Partial<AuthResolvedConfig>,
): AuthResolvedConfig {
  const config: AuthResolvedConfig = { ...DEFAULT_AUTH_CONFIG, ...overrides };
  deepFreeze(config as object);
  return config;
}
