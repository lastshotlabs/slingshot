// packages/slingshot-auth/src/types/config.ts
import { z } from 'zod';
import type {
  AuthAdapter,
  CsrfConfig,
  PostgresMigrationMode,
  RuntimePassword,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import type {
  AccountDeletionConfig,
  AuthCookieConfig,
  AuthHooksConfig,
  AuthRateLimitConfig,
  AuthSessionPolicyConfig,
  BreachedPasswordConfig,
  ConcealRegistrationConfig,
  CsrfCookieConfig,
  EmailVerificationConfig,
  JwtConfig,
  M2MConfig,
  MagicLinkConfig,
  MfaConfig,
  OAuthReauthConfig,
  OidcConfig,
  PasswordPolicyConfig,
  PasswordResetConfig,
  PrimaryField,
  RefreshTokenConfig,
  SamlConfig,
  ScimConfig,
  StepUpConfig,
} from '../config/authConfig';
import type { LockoutConfig } from '../lib/accountLockout';
import type { OAuthProviderConfig } from '../lib/oauth';

export type { StoreType };
export type {
  AccountDeletionConfig,
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
  OidcConfig,
  PasswordResetConfig,
  PrimaryField,
  RefreshTokenConfig,
  SamlConfig,
  ScimConfig,
  StepUpConfig,
} from '../config/authConfig';

/**
 * Database/store connection configuration for `slingshot-auth`.
 *
 * Controls which persistence backends are used for sessions, OAuth state, and the user
 * auth adapter. Each field is optional — defaults are chosen by the bootstrap layer
 * based on what is available (Redis → SQLite → memory).
 *
 * @remarks
 * When running under the full framework (`createApp` / `createServer`), connection objects
 * are provided automatically via `SlingshotFrameworkConfig`. These fields are only relevant
 * in standalone mode or when explicitly overriding framework-provided connections.
 *
 * @example
 * createAuthPlugin({
 *   db: {
 *     auth: 'sqlite',
 *     sessions: 'sqlite',
 *     sqlite: '/data/auth.db',
 *   },
 * });
 */
export interface AuthDbConfig {
  /** Absolute path to the SQLite database file. Required when any store is 'sqlite'. */
  sqlite?: string;
  /**
   * Auto-connect MongoDB before starting.
   * - 'single': calls connectMongo() — auth and app share one server
   * - 'separate': calls connectAuthMongo() + connectAppMongo()
   * - false: skip auto-connect
   */
  mongo?: 'single' | 'separate' | false;
  /** Auto-connect Redis before starting. Defaults to true when redis is available. */
  redis?: boolean;
  /** Postgres connection string. Required when auth store is 'postgres'. */
  postgres?: string;
  /** Postgres pool sizing and timeout options passed through to `pg.Pool`. */
  postgresPool?: AuthPostgresPoolConfig;
  /**
   * Postgres schema bootstrap strategy.
   * - "apply": runtime-owned schema initialization and migrations
   * - "assume-ready": skip startup DDL because migrations are managed externally
   */
  postgresMigrations?: PostgresMigrationMode;
  /** Where to store JWT sessions. Default: 'memory' in standalone mode. */
  sessions?: StoreType;
  /** Where to store OAuth state. Default: follows sessions. */
  oauthState?: StoreType;
  /** Which built-in auth adapter to use. Default: 'memory' in standalone mode. */
  auth?: 'mongo' | 'sqlite' | 'memory' | 'postgres';
}

export interface AuthPostgresPoolConfig {
  max?: number;
  min?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxUses?: number;
  allowExitOnIdle?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelayMillis?: number;
}

/**
 * Security configuration for `slingshot-auth`.
 *
 * Controls JWT signing, CSRF protection, bearer token auth, captcha integration,
 * trust-proxy behavior, and CORS origins used for CSRF origin checking.
 *
 * @example
 * createAuthPlugin({
 *   security: {
 *     signing: { secret: process.env.JWT_SECRET },
 *     csrf: { enabled: true },
 *     bearerTokens: [{ clientId: 'ci', token: process.env.CI_TOKEN! }],
 *   },
 * });
 */
export interface AuthSecurityConfig {
  signing?: import('@lastshotlabs/slingshot-core').SigningConfig;
  trustProxy?: false | number;
  csrf?: CsrfConfig;
  bearerAuth?: boolean | { bypass?: string[] };
  bearerTokens?: import('../config/authConfig').BearerAuthConfig;
  captcha?: import('@lastshotlabs/slingshot-core').CaptchaConfig;
  cors?: string | string[];
}

/**
 * OAuth provider configuration for `slingshot-auth`.
 *
 * Enables one or more social login providers (Google, GitHub, Apple, etc.) via the
 * optional `@lastshotlabs/slingshot-oauth` package. Requires `slingshot-oauth` to be
 * installed — startup throws if providers are configured but the package is missing.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     oauth: {
 *       providers: {
 *         google: { clientId: '...', clientSecret: '...', redirectUri: 'https://app.com/auth/google/callback' },
 *       },
 *       postRedirect: '/dashboard',
 *     },
 *   },
 * });
 */
export interface OAuthConfig {
  providers?: OAuthProviderConfig;
  postRedirect?: string;
  allowedRedirectUrls?: string[];
  reauth?: OAuthReauthConfig;
}

/**
 * Core authentication feature configuration.
 *
 * Top-level container for all behavioral auth settings: roles, OAuth, email
 * verification, password policy, MFA, JWT, session policy, rate limiting, magic links,
 * SAML, SCIM, OIDC, M2M, step-up auth, and lifecycle hooks.
 *
 * @remarks
 * Most fields are optional and have sensible defaults. Set `enabled: false` to mount
 * the plugin without registering any auth routes (useful when you only want middleware
 * such as `userAuth` and `requireRole`).
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     roles: ['admin', 'user'],
 *     defaultRole: 'user',
 *     emailVerification: { required: true },
 *     passwordReset: { tokenExpiry: 3600 },
 *     mfa: { emailOtp: { codeLength: 6 } },
 *     refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },
 *   },
 * });
 */
export interface AuthConfig {
  enabled?: boolean;
  adapter?: AuthAdapter;
  roles?: string[];
  defaultRole?: string;
  oauth?: OAuthConfig;
  primaryField?: PrimaryField;
  emailVerification?: EmailVerificationConfig;
  passwordReset?: PasswordResetConfig;
  passwordPolicy?: PasswordPolicyConfig;
  rateLimit?: AuthRateLimitConfig;
  sessionPolicy?: AuthSessionPolicyConfig;
  accountDeletion?: AccountDeletionConfig;
  refreshTokens?: RefreshTokenConfig;
  mfa?: MfaConfig;
  jwt?: JwtConfig;
  /** Check suspension status on every authenticated request. Defaults to true; set false to opt out. */
  checkSuspensionOnIdentify?: boolean;
  breachedPasswordCheck?: BreachedPasswordConfig;
  stepUp?: StepUpConfig;
  m2m?: M2MConfig;
  oidc?: OidcConfig;
  saml?: SamlConfig;
  scim?: ScimConfig;
  lockout?: LockoutConfig;
  cookieConfig?: AuthCookieConfig;
  csrfCookieConfig?: CsrfCookieConfig;
  concealRegistration?: ConcealRegistrationConfig;
  magicLink?: MagicLinkConfig;
  hooks?: AuthHooksConfig;
}

// --- Zod sub-schemas for top-level sections ---

const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().min(0);
const nonEmptyStringSchema = z.string().min(1);
const httpUrlSchema = z
  .string()
  .url()
  .refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  }, 'Expected an HTTP(S) URL');
const redirectTargetSchema = z
  .string()
  .min(1)
  .refine(value => {
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      // Invalid URL format; reject the value
      return false;
    }
  }, 'Expected a relative path or absolute HTTP(S) URL');
type CredentialStuffingDetectedHandler = NonNullable<
  NonNullable<AuthRateLimitConfig['credentialStuffing']>['onDetected']
>;
type AccountDeletionBeforeHandler = NonNullable<AccountDeletionConfig['onBeforeDelete']>;
type AccountDeletionAfterHandler = NonNullable<AccountDeletionConfig['onAfterDelete']>;
type SamlLoginHandler = NonNullable<SamlConfig['onLogin']>;
type ScimDeprovisionHandler = Extract<
  NonNullable<ScimConfig['onDeprovision']>,
  (userId: string) => Promise<void>
>;
const credentialStuffingDetectedHandlerSchema = z.custom<CredentialStuffingDetectedHandler>(
  (v): v is CredentialStuffingDetectedHandler => typeof v === 'function',
  { message: 'Expected a function' },
);
const accountDeletionBeforeHandlerSchema = z.custom<AccountDeletionBeforeHandler>(
  (v): v is AccountDeletionBeforeHandler => typeof v === 'function',
  { message: 'Expected a function' },
);
const accountDeletionAfterHandlerSchema = z.custom<AccountDeletionAfterHandler>(
  (v): v is AccountDeletionAfterHandler => typeof v === 'function',
  { message: 'Expected a function' },
);
const samlLoginHandlerSchema = z.custom<SamlLoginHandler>(
  (v): v is SamlLoginHandler => typeof v === 'function',
  { message: 'Expected a function' },
);
const scimDeprovisionHandlerSchema = z.custom<ScimDeprovisionHandler>(
  (v): v is ScimDeprovisionHandler => typeof v === 'function',
  { message: 'Expected a function' },
);
const rateLimitBucketSchema = z
  .object({
    windowMs: positiveIntSchema.optional(),
    max: positiveIntSchema.optional(),
  })
  .loose();
const oauthReauthConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    promptType: z.enum(['login', 'consent', 'select_account']).optional(),
  })
  .loose();
const oauthConfigSchema = z
  .object({
    providers: z
      .custom<OAuthProviderConfig>(v => v == null || typeof v === 'object', {
        message: 'Expected an OAuth provider config object',
      })
      .optional(),
    postRedirect: redirectTargetSchema.optional(),
    allowedRedirectUrls: z.array(httpUrlSchema).optional(),
    reauth: oauthReauthConfigSchema.optional(),
  })
  .loose();
const emailVerificationConfigSchema = z
  .object({
    required: z.boolean().optional(),
    tokenExpiry: positiveIntSchema.optional(),
  })
  .loose();
const passwordResetConfigSchema = z.object({ tokenExpiry: positiveIntSchema.optional() }).loose();
const magicLinkConfigSchema = z
  .object({
    ttlSeconds: positiveIntSchema.optional(),
    linkBaseUrl: httpUrlSchema.optional(),
    tokenLocation: z.enum(['fragment', 'query']).optional(),
    store: z.enum(['memory', 'redis', 'sqlite', 'mongo']).optional(),
  })
  .loose();
const passwordPolicyConfigSchema = z
  .object({
    minLength: positiveIntSchema.max(128).optional(),
    requireLetter: z.boolean().optional(),
    requireDigit: z.boolean().optional(),
    requireSpecial: z.boolean().optional(),
    preventReuse: nonNegativeIntSchema.optional(),
  })
  .loose();
const authRateLimitConfigSchema = z
  .object({
    login: rateLimitBucketSchema.optional(),
    register: rateLimitBucketSchema.optional(),
    verifyEmail: rateLimitBucketSchema.optional(),
    resendVerification: rateLimitBucketSchema.optional(),
    forgotPassword: rateLimitBucketSchema.optional(),
    resetPassword: rateLimitBucketSchema.optional(),
    deleteAccount: rateLimitBucketSchema.optional(),
    mfaVerify: rateLimitBucketSchema.optional(),
    mfaEmailOtpInitiate: rateLimitBucketSchema.optional(),
    mfaResend: rateLimitBucketSchema.optional(),
    setPassword: rateLimitBucketSchema.optional(),
    mfaDisable: rateLimitBucketSchema.optional(),
    oauthUnlink: rateLimitBucketSchema.optional(),
    store: z.enum(['memory', 'redis']).optional(),
    credentialStuffing: z
      .object({
        maxAccountsPerIp: z
          .object({ count: positiveIntSchema, windowMs: positiveIntSchema })
          .optional(),
        maxIpsPerAccount: z
          .object({ count: positiveIntSchema, windowMs: positiveIntSchema })
          .optional(),
        onDetected: credentialStuffingDetectedHandlerSchema.optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const sessionPolicyConfigSchema = z
  .object({
    maxSessions: positiveIntSchema.optional(),
    persistSessionMetadata: z.boolean().optional(),
    includeInactiveSessions: z.boolean().optional(),
    trackLastActive: z.boolean().optional(),
    absoluteTimeout: positiveIntSchema.optional(),
    idleTimeout: positiveIntSchema.optional(),
    onPasswordChange: z.enum(['revoke_others', 'revoke_all_and_reissue', 'none']).optional(),
  })
  .loose();
const accountDeletionConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    onBeforeDelete: accountDeletionBeforeHandlerSchema.optional(),
    onAfterDelete: accountDeletionAfterHandlerSchema.optional(),
    queued: z.boolean().optional(),
    gracePeriod: nonNegativeIntSchema.optional(),
    requireVerification: z.boolean().optional(),
    requirePasswordConfirmation: z.boolean().optional(),
  })
  .loose();
const refreshTokenConfigSchema = z
  .object({
    accessTokenExpiry: positiveIntSchema.optional(),
    refreshTokenExpiry: positiveIntSchema.optional(),
    rotationGraceSeconds: nonNegativeIntSchema.optional(),
  })
  .loose();
const mfaConfigSchema = z
  .object({
    issuer: nonEmptyStringSchema.optional(),
    algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).optional(),
    digits: positiveIntSchema.min(6).max(8).optional(),
    period: positiveIntSchema.optional(),
    recoveryCodes: positiveIntSchema.optional(),
    challengeTtlSeconds: positiveIntSchema.optional(),
    emailOtp: z
      .object({ codeLength: positiveIntSchema.min(4).max(10).optional() })
      .loose()
      .optional(),
    webauthn: z
      .object({
        rpId: nonEmptyStringSchema,
        rpName: nonEmptyStringSchema.optional(),
        origin: z.union([httpUrlSchema, z.array(httpUrlSchema).min(1)]),
        attestationType: z.enum(['none', 'direct', 'enterprise']).optional(),
        authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
        userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
        timeout: positiveIntSchema.optional(),
        strictSignCount: z.boolean().optional(),
        allowPasswordlessLogin: z.boolean().optional(),
        passkeyMfaBypass: z.boolean().optional(),
      })
      .loose()
      .optional(),
    required: z.boolean().optional(),
  })
  .loose();
const jwtConfigSchema = z
  .object({
    issuer: nonEmptyStringSchema.optional(),
    audience: z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema).min(1)]).optional(),
    algorithm: z.enum(['HS256', 'RS256']).optional(),
    clockTolerance: nonNegativeIntSchema.optional(),
  })
  .loose();
const breachedPasswordConfigSchema = z
  .object({
    block: z.boolean().optional(),
    minBreachCount: nonNegativeIntSchema.optional(),
    timeout: positiveIntSchema.optional(),
    onApiFailure: z.enum(['allow', 'block']).optional(),
  })
  .loose();
const stepUpConfigSchema = z.object({ maxAge: positiveIntSchema.optional() }).loose();
const m2mConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    tokenExpiry: positiveIntSchema.optional(),
    scopes: z.array(nonEmptyStringSchema).optional(),
    recheckClientOnUse: z.boolean().optional(),
  })
  .loose();
const oidcKeySchema = z
  .object({
    privateKey: nonEmptyStringSchema,
    publicKey: nonEmptyStringSchema,
    kid: nonEmptyStringSchema.optional(),
  })
  .loose();
const oidcPreviousKeySchema = z
  .object({ publicKey: nonEmptyStringSchema, kid: nonEmptyStringSchema.optional() })
  .loose();
const oidcConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    issuer: httpUrlSchema,
    signingKey: oidcKeySchema.optional(),
    previousKeys: z.array(oidcPreviousKeySchema).optional(),
    scopes: z.array(nonEmptyStringSchema).optional(),
    tokenEndpoint: httpUrlSchema.optional(),
    authorizationEndpoint: httpUrlSchema.optional(),
  })
  .loose();
const samlConfigSchema = z
  .object({
    entityId: nonEmptyStringSchema,
    acsUrl: httpUrlSchema,
    idpMetadata: nonEmptyStringSchema,
    signingKey: nonEmptyStringSchema.optional(),
    signingCert: nonEmptyStringSchema.optional(),
    attributeMapping: z
      .object({
        email: nonEmptyStringSchema.optional(),
        firstName: nonEmptyStringSchema.optional(),
        lastName: nonEmptyStringSchema.optional(),
        groups: nonEmptyStringSchema.optional(),
      })
      .loose()
      .optional(),
    onLogin: samlLoginHandlerSchema.optional(),
    postLoginRedirect: redirectTargetSchema.optional(),
  })
  .loose();
const scimConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    bearerTokens: z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema).min(1)]),
    userMapping: z
      .object({ userName: z.enum(['email', 'username']).optional() })
      .loose()
      .optional(),
    onDeprovision: z
      .union([z.enum(['suspend', 'delete']), scimDeprovisionHandlerSchema])
      .optional(),
  })
  .loose();
const authCookieConfigSchema = z
  .object({
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
    secure: z.boolean().optional(),
    domain: nonEmptyStringSchema.optional(),
    path: z.string().startsWith('/').optional(),
    maxAge: positiveIntSchema.optional(),
  })
  .loose();
const csrfCookieConfigSchema = authCookieConfigSchema;

const authDbConfigSchema = z
  .object({
    sqlite: z
      .string()
      .optional()
      .describe("Absolute path to the SQLite database file. Omit unless a store uses 'sqlite'."),
    mongo: z
      .union([z.enum(['single', 'separate']), z.literal(false)])
      .optional()
      .describe(
        'Mongo auto-connect mode. One of: single, separate, false. Omit to use the bootstrap default.',
      ),
    redis: z
      .boolean()
      .optional()
      .describe(
        'Whether Redis should auto-connect before startup. Omit to use the bootstrap default.',
      ),
    postgres: z
      .string()
      .optional()
      .describe(
        "Postgres connection string for auth persistence. Omit unless a store uses 'postgres'.",
      ),
    postgresPool: z
      .object({
        max: positiveIntSchema.optional(),
        min: nonNegativeIntSchema.optional(),
        idleTimeoutMs: positiveIntSchema.optional(),
        connectionTimeoutMs: positiveIntSchema.optional(),
        queryTimeoutMs: positiveIntSchema.optional(),
        statementTimeoutMs: positiveIntSchema.optional(),
        maxUses: positiveIntSchema.optional(),
        allowExitOnIdle: z.boolean().optional(),
        keepAlive: z.boolean().optional(),
        keepAliveInitialDelayMillis: nonNegativeIntSchema.optional(),
      })
      .optional()
      .describe('Postgres pool sizing and timeout options passed through to pg.Pool.'),
    postgresMigrations: z
      .enum(['apply', 'assume-ready'])
      .optional()
      .describe(
        'Postgres schema bootstrap strategy. Use "assume-ready" when migrations are managed externally.',
      ),
    sessions: z
      .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
      .optional()
      .describe(
        'Persistence backend for auth sessions. One of: redis, mongo, sqlite, memory, postgres. Omit to use the standalone default.',
      ),
    oauthState: z
      .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
      .optional()
      .describe(
        'Persistence backend for OAuth state. One of: redis, mongo, sqlite, memory, postgres. Omit to follow the sessions store.',
      ),
    auth: z
      .enum(['mongo', 'sqlite', 'memory', 'postgres'])
      .optional()
      .describe(
        'Built-in auth adapter backend. One of: mongo, sqlite, memory, postgres. Omit to use the standalone default.',
      ),
  })
  .loose();

const authSecurityConfigSchema = z
  .object({
    signing: z
      .custom<import('@lastshotlabs/slingshot-core').SigningConfig>(
        v => v == null || typeof v === 'object',
        { message: 'Expected a SigningConfig object' },
      )
      .optional()
      .describe(
        'JWT and request-signing configuration. Omit to use the framework or plugin defaults.',
      ),
    trustProxy: z
      .union([z.literal(false), nonNegativeIntSchema])
      .optional()
      .describe(
        'Proxy trust setting for auth request handling. Use false or a hop count. Omit to use the app default.',
      ),
    csrf: z
      .custom<CsrfConfig>(v => v == null || typeof v === 'object', {
        message: 'Expected a CsrfConfig object',
      })
      .optional()
      .describe(
        'CSRF protection configuration for auth routes. Omit to use the plugin default CSRF behavior.',
      ),
    bearerAuth: z
      .union([
        z.boolean(),
        z
          .object({
            bypass: z
              .array(z.string())
              .optional()
              .describe(
                'Path patterns that bypass bearer-token authentication. Omit to require bearer auth on all configured routes.',
              ),
          })
          .loose(),
      ])
      .optional()
      .describe(
        'Bearer-token authentication toggle or bypass configuration. Omit to use the plugin default bearer-auth behavior.',
      ),
    bearerTokens: z
      .union([
        nonEmptyStringSchema,
        z.array(nonEmptyStringSchema),
        z.array(
          z.object({
            clientId: nonEmptyStringSchema.describe(
              'Client identifier associated with the bearer token.',
            ),
            token: nonEmptyStringSchema.describe(
              'Static bearer token value presented by the client.',
            ),
            description: z
              .string()
              .optional()
              .describe(
                'Human-readable label for the token. Omit to store the token without a description.',
              ),
            revoked: z
              .boolean()
              .optional()
              .describe('Whether the token is revoked. Omit to treat the token as active.'),
          }),
        ),
      ])
      .optional()
      .describe(
        'Static bearer tokens accepted by auth routes. Omit to disable static bearer tokens.',
      ),
    captcha: z
      .custom<import('@lastshotlabs/slingshot-core').CaptchaConfig>(
        v => v == null || typeof v === 'object',
        { message: 'Expected a CaptchaConfig object' },
      )
      .optional()
      .describe('Captcha provider configuration for auth flows. Omit to disable captcha checks.'),
    cors: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Allowed origins used for auth CORS and CSRF origin checks. Omit to use the app default CORS policy.',
      ),
  })
  .loose();

// AuthConfig has many deeply nested sub-configs — use z.custom for most
const authConfigSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Whether auth routes are registered. Omit to use the plugin default, or set false to disable auth routes.',
    ),
  adapter: z
    .custom<AuthAdapter>(v => v == null || typeof v === 'object', {
      message: 'Expected an AuthAdapter instance',
    })
    .optional()
    .describe(
      'Explicit auth adapter instance. Omit to let the plugin create a built-in adapter from db settings.',
    ),
  roles: z
    .array(z.string())
    .optional()
    .describe(
      'Available application roles managed by the auth plugin. Omit to use the built-in role defaults.',
    ),
  defaultRole: z
    .string()
    .optional()
    .describe(
      'Role assigned to newly created users by default. Omit to use the plugin default role assignment.',
    ),
  oauth: oauthConfigSchema
    .optional()
    .describe(
      'OAuth provider configuration for social login flows. Omit to disable OAuth providers.',
    ),
  primaryField: z
    .enum(['email', 'username', 'phone'])
    .optional()
    .describe(
      'Primary login identifier field. One of: email, username, phone. Omit to use the plugin default.',
    ),
  emailVerification: emailVerificationConfigSchema
    .optional()
    .describe(
      'Email-verification behavior for newly registered users. Omit to use the plugin default verification flow.',
    ),
  passwordReset: passwordResetConfigSchema
    .optional()
    .describe(
      'Password-reset behavior and token settings. Omit to use the plugin default password-reset flow.',
    ),
  passwordPolicy: passwordPolicyConfigSchema
    .optional()
    .describe(
      'Password policy requirements enforced during credential changes. Omit to use the plugin default policy.',
    ),
  rateLimit: authRateLimitConfigSchema
    .optional()
    .describe(
      'Rate-limiting configuration for auth endpoints. Omit to use the plugin default auth rate limits.',
    ),
  sessionPolicy: sessionPolicyConfigSchema
    .optional()
    .describe(
      'Session issuance and lifetime policy for authenticated users. Omit to use the plugin default session policy.',
    ),
  accountDeletion: accountDeletionConfigSchema
    .optional()
    .describe(
      'Account-deletion behavior for self-service user deletion flows. Omit to use the plugin default deletion behavior.',
    ),
  refreshTokens: refreshTokenConfigSchema
    .optional()
    .describe(
      'Refresh-token issuance and rotation settings. Omit to use the plugin default refresh-token behavior.',
    ),
  mfa: mfaConfigSchema
    .optional()
    .describe(
      'Multi-factor authentication configuration. Omit to use the plugin default MFA behavior.',
    ),
  jwt: jwtConfigSchema
    .optional()
    .describe(
      'JWT issuance and verification configuration. Omit to use the plugin default JWT behavior.',
    ),
  checkSuspensionOnIdentify: z
    .boolean()
    .optional()
    .describe(
      'Whether user suspension is checked on every authenticated request. Omit to use the default of true.',
    ),
  breachedPasswordCheck: breachedPasswordConfigSchema
    .optional()
    .describe(
      'Breached-password detection configuration. Omit to use the plugin default breached-password behavior.',
    ),
  stepUp: stepUpConfigSchema
    .optional()
    .describe(
      'Step-up authentication requirements for sensitive operations. Omit to use the plugin default step-up behavior.',
    ),
  m2m: m2mConfigSchema
    .optional()
    .describe(
      'Machine-to-machine authentication configuration. Omit to disable M2M auth features.',
    ),
  oidc: oidcConfigSchema
    .optional()
    .describe('OIDC provider configuration. Omit to disable OIDC support.'),
  saml: samlConfigSchema
    .optional()
    .describe('SAML provider configuration. Omit to disable SAML support.'),
  scim: scimConfigSchema
    .optional()
    .describe('SCIM provisioning configuration. Omit to disable SCIM support.'),
  lockout: z
    .custom<LockoutConfig>(v => v == null || typeof v === 'object', {
      message: 'Expected a LockoutConfig object',
    })
    .optional()
    .describe(
      'Account lockout policy for repeated authentication failures. Omit to use the plugin default lockout behavior.',
    ),
  cookieConfig: authCookieConfigSchema
    .optional()
    .describe(
      'Cookie configuration for auth session cookies. Omit to use the plugin default cookie settings.',
    ),
  csrfCookieConfig: csrfCookieConfigSchema
    .optional()
    .describe(
      'Cookie configuration for CSRF cookies. Omit to use the plugin default CSRF cookie settings.',
    ),
  concealRegistration: z
    .custom<ConcealRegistrationConfig>(v => v == null || typeof v === 'object', {
      message: 'Expected a ConcealRegistrationConfig object',
    })
    .optional()
    .describe(
      'Registration-concealment behavior for anti-enumeration flows. Omit to use the plugin default concealment behavior.',
    ),
  magicLink: magicLinkConfigSchema
    .optional()
    .describe('Magic-link authentication configuration. Omit to disable magic-link login.'),
  hooks: z
    .custom<AuthHooksConfig>(v => v == null || typeof v === 'object', {
      message: 'Expected an AuthHooksConfig object',
    })
    .optional()
    .describe('Lifecycle hooks for auth events and flows. Omit to register no custom auth hooks.'),
});

/**
 * Zod schema for the full `AuthPluginConfig` object.
 *
 * Used internally by `createAuthPlugin` to validate the raw config at startup.
 * Exported for consumers who want to pre-validate config before passing it to the plugin
 * (e.g., in tests or server-config loaders).
 *
 * @example
 * import { authPluginConfigSchema } from '@lastshotlabs/slingshot-auth';
 *
 * const result = authPluginConfigSchema.safeParse(rawConfig);
 * if (!result.success) {
 *   console.error('Invalid auth config:', result.error.flatten());
 * }
 */
export const authPluginConfigSchema = z
  .object({
    auth: authConfigSchema
      .optional()
      .describe('Core authentication feature configuration. Omit to use the plugin defaults.'),
    db: authDbConfigSchema
      .optional()
      .describe(
        'Persistence backend configuration for auth storage concerns. Omit to use the bootstrap defaults.',
      ),
    security: authSecurityConfigSchema
      .optional()
      .describe(
        'Security controls for auth routes, signing, CSRF, and bearer tokens. Omit to use the plugin defaults.',
      ),
    securityEvents: z
      .custom<import('../lib/securityEventWiring').SecurityEventsConfig>(
        v => v == null || typeof v === 'object',
        { message: 'Expected a SecurityEventsConfig object' },
      )
      .optional()
      .describe(
        'Security event wiring for audit or alerting integrations. Omit to use the plugin default security event behavior.',
      ),
    emailTemplates: z
      .custom<import('../config/authConfig').EmailTemplatesConfig>(
        v => v == null || typeof v === 'object',
        { message: 'Expected an EmailTemplatesConfig object' },
      )
      .optional()
      .describe(
        'Email template overrides for auth-generated mail. Omit to use the built-in templates.',
      ),
    appName: z
      .string()
      .optional()
      .describe(
        'Application name inserted into auth UI and email templates. Omit to use the runtime default app name.',
      ),
  })
  .loose();

type AuthPluginConfigBase = z.infer<typeof authPluginConfigSchema>;

/**
 * Runtime dependencies for standalone auth usage (without the full framework).
 *
 * When used with the full framework (createApp / createServer), these are
 * provided automatically via SlingshotFrameworkConfig. When used standalone
 * (plugin.setup() only), they must be passed here.
 */
export interface AuthStandaloneRuntime {
  /** Password hashing/verification — required in standalone mode. */
  password: RuntimePassword;
  /** SQLite database opener — required when any store is 'sqlite' in standalone mode. */
  sqlite?: { open(path: string): import('@lastshotlabs/slingshot-core').RuntimeSqliteDatabase };
}

/**
 * Full plugin configuration object for `createAuthPlugin`.
 *
 * Combines the Zod-validated base config with the `runtime` field (standalone-only
 * dependencies injected outside of Zod validation).
 *
 * @example
 * import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
 * import type { AuthPluginConfig } from '@lastshotlabs/slingshot-auth';
 *
 * const config: AuthPluginConfig = {
 *   auth: { roles: ['admin', 'user'], defaultRole: 'user' },
 *   db: { sessions: 'redis' },
 *   security: { signing: { secret: process.env.JWT_SECRET } },
 * };
 * const plugin = createAuthPlugin(config);
 */
export interface AuthPluginConfig extends AuthPluginConfigBase {
  /**
   * Standalone runtime dependencies.
   * Ignored when using the full framework (framework injects these via SlingshotFrameworkConfig).
   */
  runtime?: AuthStandaloneRuntime;
}
