import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `security.signing.presignedUrls` sub-section.
 *
 * @remarks
 * **Fields:**
 * - `defaultExpiry` — Lifetime of a generated presigned URL in seconds.
 *   Defaults to 3600 (1 hour) when omitted.
 *
 * @example
 * ```ts
 * security: {
 *   signing: {
 *     presignedUrls: { defaultExpiry: 1800 },
 *   },
 * }
 * ```
 */
export const signingPresignedUrlsSchema = z.object({ defaultExpiry: z.number().optional() });

/**
 * Zod schema for the `security.signing.requestSigning` sub-section.
 *
 * Request signing validates inbound requests using an HMAC signature embedded
 * in a request header. This is typically used for server-to-server webhooks or
 * machine-client integrations.
 *
 * @remarks
 * **Fields:**
 * - `tolerance` — Clock-skew tolerance in milliseconds. Requests whose
 *   timestamp deviates from the server clock by more than this value are
 *   rejected. Defaults to 300000 (5 minutes).
 * - `header` — Name of the HTTP header that carries the HMAC signature.
 *   Defaults to `"X-Slingshot-Signature"`.
 * - `timestampHeader` — Name of the HTTP header that carries the request
 *   timestamp (Unix ms). Defaults to `"X-Slingshot-Timestamp"`.
 *
 * @example
 * ```ts
 * security: {
 *   signing: {
 *     requestSigning: {
 *       tolerance: 60000,
 *       header: 'X-My-Signature',
 *       timestampHeader: 'X-My-Timestamp',
 *     },
 *   },
 * }
 * ```
 */
export const signingRequestSigningSchema = z.object({
  tolerance: z.number().optional(),
  header: z.string().optional(),
  timestampHeader: z.string().optional(),
});

/**
 * Zod schema for the `security.signing.sessionBinding` sub-section.
 *
 * Session binding ties a session token to specific properties of the original
 * request so that stolen tokens cannot be replayed from a different client.
 *
 * @remarks
 * **Fields:**
 * - `fields` — Which request attributes are hashed into the session fingerprint.
 *   Accepts any subset of `["ip", "ua", "accept-language"]`. Defaults to
 *   `["ip", "ua"]` when `sessionBinding` is enabled without an explicit object.
 * - `onMismatch` — Action taken when the current request's fingerprint does not
 *   match the stored fingerprint:
 *   - `"unauthenticate"` (default) — Destroy the session and redirect to login.
 *   - `"reject"` — Return 403 without destroying the session (useful for APIs).
 *   - `"log-only"` — Record the mismatch but allow the request through.
 *     Suitable for canary-testing session binding without enforcing it.
 *
 * @example
 * ```ts
 * security: {
 *   signing: {
 *     sessionBinding: {
 *       fields: ['ip', 'ua'],
 *       onMismatch: 'reject',
 *     },
 *   },
 * }
 * ```
 */
export const signingSessionBindingSchema = z.object({
  fields: z.array(z.enum(['ip', 'ua', 'accept-language'])).optional(),
  onMismatch: z.enum(['unauthenticate', 'reject', 'log-only']).optional(),
});

/**
 * Zod schema for the `security.signing` sub-section of `CreateServerConfig`.
 *
 * Centralised HMAC signing configuration. Controls which framework-level data
 * structures are cryptographically signed and verified.
 *
 * @remarks
 * **Fields:**
 * - `secret` — HMAC signing secret string, or array of strings for key
 *   rotation (latest key signs; all keys verify). **Required** when any signing
 *   feature is enabled. The framework throws at startup if a signing feature is
 *   active but no secret is provided.
 * - `cookies` — When `true`, session cookies are HMAC-signed to detect
 *   tampering. Defaults to `false`.
 * - `cursors` — When `true`, pagination cursor tokens are HMAC-signed to
 *   prevent enumeration attacks. Defaults to `false`.
 * - `presignedUrls` — Enable signed URL generation. `true` uses default
 *   options; pass a {@link signingPresignedUrlsSchema} object to customise
 *   expiry. Defaults to `false`.
 * - `requestSigning` — Enable inbound HMAC request-signature verification.
 *   `true` uses defaults; pass a {@link signingRequestSigningSchema} object for
 *   custom header names and clock-skew tolerance. Defaults to `false`.
 * - `idempotencyKeys` — When `true`, idempotency key tokens embedded in
 *   request headers are signed to prevent forgery. Defaults to `false`.
 * - `sessionBinding` — Bind sessions to client fingerprint fields. `true` uses
 *   default fields (`["ip", "ua"]`); pass a {@link signingSessionBindingSchema}
 *   object to customise. Defaults to `false`.
 *
 * **Key rotation:** When `secret` is an array, the first element is the active
 * signing key. All elements are used for verification, enabling zero-downtime
 * key rotation.
 *
 * @example
 * ```ts
 * security: {
 *   signing: {
 *     secret: [process.env.SIGNING_SECRET_NEW, process.env.SIGNING_SECRET_OLD],
 *     cookies: true,
 *     cursors: true,
 *     presignedUrls: { defaultExpiry: 900 },
 *     sessionBinding: { fields: ['ip', 'ua'], onMismatch: 'reject' },
 *   },
 * }
 * ```
 */
export const signingSchema = z.object({
  secret: z.union([z.string(), z.array(z.string())]).optional(),
  cookies: z.boolean().optional(),
  cursors: z.boolean().optional(),
  presignedUrls: z.union([z.boolean(), signingPresignedUrlsSchema.loose()]).optional(),
  requestSigning: z.union([z.boolean(), signingRequestSigningSchema.loose()]).optional(),
  idempotencyKeys: z.boolean().optional(),
  sessionBinding: z.union([z.boolean(), signingSessionBindingSchema.loose()]).optional(),
});

/**
 * Zod schema for the `security.rateLimit` sub-section of `CreateServerConfig`.
 *
 * Configures the global rate-limiting middleware applied to all routes before
 * application middleware. Uses a sliding-window algorithm keyed by IP address
 * by default.
 *
 * @remarks
 * **Fields:**
 * - `windowMs` — Length of the rate-limit window in milliseconds. Defaults to
 *   60000 (1 minute).
 * - `max` — Maximum number of requests allowed per `windowMs` per key. Defaults
 *   to 100.
 * - `message` — Response body string sent when the limit is exceeded. Defaults
 *   to `"Too many requests"`.
 * - `standardHeaders` — When `true`, the `RateLimit-*` headers specified in
 *   the IETF draft are included in every response. Defaults to `true`.
 * - `keyGenerator` — Function `(c: Context) => string` that derives the
 *   rate-limit key from the request. Defaults to `c.req.header("x-forwarded-for") ?? ip`.
 * - `skip` — Predicate `(c: Context) => boolean`. When it returns `true` for a
 *   request, rate limiting is bypassed entirely for that request.
 * - `handler` — Custom Hono handler `(c: Context) => Response` invoked instead
 *   of the default 429 response when the limit is exceeded.
 *
 * Set `security.rateLimit` to `false` to disable rate limiting entirely.
 *
 * @example
 * ```ts
 * security: {
 *   rateLimit: {
 *     windowMs: 15 * 60 * 1000,
 *     max: 200,
 *     skip: (c) => c.req.path.startsWith('/health'),
 *   },
 * }
 * ```
 */
export const rateLimitSchema = z.object({
  windowMs: z.number().optional(),
  max: z.number().optional(),
  message: z.string().optional(),
  standardHeaders: z.boolean().optional(),
  keyGenerator: fnSchema.optional(),
  skip: fnSchema.optional(),
  handler: fnSchema.optional(),
});

/**
 * Zod schema for the `security.cors` sub-section when supplied as a plain object.
 *
 * Controls the Cross-Origin Resource Sharing (CORS) headers added to responses.
 * `security.cors` can also be a string or array of strings; those shorthand
 * forms are normalised to `{ origin: ... }` at runtime.
 *
 * @remarks
 * **Fields:**
 * - `origin` — Allowed origin string (exact match), or array of strings for
 *   multi-origin allowlists. **Required** in the object form.
 * - `credentials` — When `true`, the `Access-Control-Allow-Credentials: true`
 *   header is included. Must be `true` when the client sends cookies. Defaults
 *   to `false`.
 * - `allowHeaders` — Array of header names included in
 *   `Access-Control-Allow-Headers`. Defaults to the value of the request's
 *   `Access-Control-Request-Headers` when omitted (reflect-back mode).
 * - `exposeHeaders` — Array of response headers the browser is allowed to read.
 *   Defaults to none (only CORS-safe headers are readable without this).
 * - `maxAge` — Seconds the browser may cache the preflight result. Defaults to
 *   browser default (typically 5 seconds).
 *
 * @example
 * ```ts
 * security: {
 *   cors: {
 *     origin: ['https://app.example.com', 'https://staging.example.com'],
 *     credentials: true,
 *     allowHeaders: ['Content-Type', 'Authorization'],
 *   },
 * }
 * ```
 */
export const corsObjectSchema = z.object({
  origin: z.union([z.string(), z.array(z.string())]),
  credentials: z.boolean().optional(),
  allowHeaders: z.array(z.string()).optional(),
  exposeHeaders: z.array(z.string()).optional(),
  maxAge: z.number().optional(),
});

/**
 * Zod schema for the `security.captcha` sub-section of `CreateServerConfig`.
 *
 * Enables server-side CAPTCHA token verification on protected routes. The
 * framework validates the client-supplied token against the configured provider
 * before calling the route handler.
 *
 * @remarks
 * **Fields:**
 * - `provider` — CAPTCHA provider identifier (e.g. `"recaptcha-v3"`,
 *   `"turnstile"`, `"hcaptcha"`). Must match a registered provider name.
 * - `secretKey` — Server-side secret key issued by the CAPTCHA provider.
 *   **Required.** Keep this out of source control; prefer an environment
 *   variable reference.
 * - `minScore` — Minimum risk score (0–1) required to pass. Applicable to
 *   score-based providers (e.g. reCAPTCHA v3). Requests below the threshold
 *   receive a 403. Defaults to `0.5`.
 * - `tokenField` — Name of the request body field or query parameter that
 *   carries the CAPTCHA token. Defaults to `"captchaToken"`.
 * - `adaptive` — When `true`, the CAPTCHA check is only enforced when the
 *   current request exhibits suspicious patterns (e.g. high request rate from
 *   the same IP). Defaults to `false`.
 * - `adaptiveThreshold` — Requests-per-minute rate above which adaptive mode
 *   begins enforcing the CAPTCHA check. Defaults to 10.
 *
 * Set `security.captcha` to `false` to disable CAPTCHA verification entirely.
 *
 * @example
 * ```ts
 * security: {
 *   captcha: {
 *     provider: 'recaptcha-v3',
 *     secretKey: process.env.RECAPTCHA_SECRET,
 *     minScore: 0.7,
 *   },
 * }
 * ```
 */
export const captchaSchema = z.object({
  provider: z.string(),
  secretKey: z.string(),
  minScore: z.number().optional(),
  tokenField: z.string().optional(),
  adaptive: z.boolean().optional(),
  adaptiveThreshold: z.number().optional(),
});

/**
 * Zod schema for the `security.botProtection` sub-section of `CreateServerConfig`.
 *
 * Adds lightweight bot-detection heuristics applied globally before route
 * handlers. Does not replace a full WAF but provides a first line of defence
 * against scripted abuse.
 *
 * @remarks
 * **Fields:**
 * - `blockList` — Array of User-Agent substring patterns. Requests whose
 *   `User-Agent` header contains any pattern are rejected with 403. Case-
 *   insensitive substring match.
 * - `fingerprintRateLimit` — When `true`, applies a separate rate-limit window
 *   keyed by a browser fingerprint hash (derived from User-Agent, Accept,
 *   Accept-Language, etc.) in addition to the IP-based limit configured in
 *   `rateLimit`. Useful for detecting bots that rotate IPs.
 *
 * Set `security.botProtection` to `false` to disable bot protection entirely.
 *
 * @example
 * ```ts
 * security: {
 *   botProtection: {
 *     blockList: ['curl/', 'python-requests', 'scrapy'],
 *     fingerprintRateLimit: true,
 *   },
 * }
 * ```
 */
export const botProtectionSchema = z.object({
  blockList: z.array(z.string()).optional(),
  fingerprintRateLimit: z.boolean().optional(),
});

/**
 * Zod schema for the top-level `security` section of `CreateAppConfig` /
 * `CreateServerConfig`.
 *
 * Aggregates all security-related middleware configuration. Each sub-section
 * can be enabled independently; omitting a sub-section leaves that feature
 * disabled (or uses its built-in default).
 *
 * @remarks
 * **Fields:**
 * - `cors` — CORS policy. Accepts a shorthand origin string, array of origin
 *   strings, or a full {@link corsObjectSchema} object. Omit to disable CORS
 *   headers entirely (cross-origin requests will fail browser preflight).
 * - `headers` — Security response headers (e.g. CSP, HSTS, X-Frame-Options).
 *   `true` applies the opinionated built-in preset. A `Record<string, string>`
 *   replaces the preset with an exact header map. `false` / omit disables.
 * - `rateLimit` — Global rate-limit middleware. See {@link rateLimitSchema}.
 *   Set to `false` to disable.
 * - `botProtection` — Bot-detection heuristics. See {@link botProtectionSchema}.
 *   Set to `false` to disable.
 * - `trustProxy` — How many layers of trusted reverse proxies sit in front of
 *   the server. Controls `x-forwarded-for` parsing for IP extraction.
 *   `false` disables proxy trust (default). A number `n` trusts the nth hop.
 * - `signing` — HMAC signing for cookies, cursors, presigned URLs, and more.
 *   See {@link signingSchema}.
 * - `captcha` — CAPTCHA verification. See {@link captchaSchema}. Set to `false`
 *   to disable.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * security: {
 *   cors: 'https://app.example.com',
 *   headers: true,
 *   rateLimit: { windowMs: 60000, max: 100 },
 *   trustProxy: 1,
 *   signing: {
 *     secret: process.env.SIGNING_SECRET,
 *     cookies: true,
 *   },
 * }
 * ```
 */
export const securitySchema = z.object({
  cors: z.union([z.string(), z.array(z.string()), corsObjectSchema.loose()]).optional(),
  headers: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  rateLimit: z.union([rateLimitSchema.loose(), z.literal(false)]).optional(),
  botProtection: z.union([botProtectionSchema.loose(), z.literal(false)]).optional(),
  trustProxy: z.union([z.literal(false), z.number()]).optional(),
  signing: signingSchema.loose().optional(),
  captcha: z.union([captchaSchema.loose(), z.literal(false)]).optional(),
});
