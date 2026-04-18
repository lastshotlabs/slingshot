import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- CORS --
const corsObjectSchema = z.object({
  origin: z
    .union([z.string(), z.array(z.string())])
    .describe('Allowed origin or origins for CORS requests.'),
  credentials: z
    .boolean()
    .optional()
    .describe('Whether CORS responses allow credentials. Omit to use the CORS middleware default.'),
  allowHeaders: z
    .array(z.string())
    .optional()
    .describe(
      'Request headers clients may send in CORS requests. Omit to use the CORS middleware default.',
    ),
  exposeHeaders: z
    .array(z.string())
    .optional()
    .describe(
      'Response headers exposed to browsers for CORS requests. Omit to use the CORS middleware default.',
    ),
  maxAge: z
    .number()
    .optional()
    .describe('CORS preflight cache lifetime in seconds. Omit to use the CORS middleware default.'),
});

// -- Signing --
const signingSchema = z.object({
  cookies: z
    .boolean()
    .optional()
    .describe('Whether framework-managed cookies are signed. Omit to use the framework default.'),
  cursors: z
    .boolean()
    .optional()
    .describe('Whether pagination cursors are signed. Omit to use the framework default.'),
  presignedUrls: z
    .union([
      z.boolean(),
      z
        .object({
          defaultExpiry: z
            .number()
            .optional()
            .describe(
              'Default presigned URL expiry in seconds. Omit to use the upload subsystem default.',
            ),
        })
        .loose(),
    ])
    .optional()
    .describe(
      'Whether presigned URLs are signed and, optionally, how long they last. Omit to use the framework default.',
    ),
  requestSigning: z
    .union([
      z.boolean(),
      z
        .object({
          tolerance: z
            .number()
            .optional()
            .describe(
              'Allowed clock skew for signed requests in milliseconds. Omit to use the framework default tolerance.',
            ),
          header: z
            .string()
            .optional()
            .describe(
              'Header name carrying the request signature. Omit to use the framework default header.',
            ),
          timestampHeader: z
            .string()
            .optional()
            .describe(
              'Header name carrying the request timestamp. Omit to use the framework default timestamp header.',
            ),
        })
        .loose(),
    ])
    .optional()
    .describe(
      'Whether signed-request validation is enabled and, optionally, how it is configured. Omit to use the framework default.',
    ),
  idempotencyKeys: z
    .boolean()
    .optional()
    .describe('Whether idempotency keys are signed. Omit to use the framework default.'),
  sessionBinding: z
    .union([
      z.boolean(),
      z
        .object({
          fields: z
            .array(z.enum(['ip', 'ua', 'accept-language']))
            .optional()
            .describe(
              'Request fields bound to the session. One or more of: ip, ua, accept-language. Omit to use the framework default fields.',
            ),
          onMismatch: z
            .enum(['unauthenticate', 'reject', 'log-only'])
            .optional()
            .describe(
              'Action taken when a session-binding check fails. One of: unauthenticate, reject, log-only. Omit to use the framework default.',
            ),
        })
        .loose(),
    ])
    .optional()
    .describe(
      'Whether session binding is enabled and, optionally, how mismatches are handled. Omit to use the framework default.',
    ),
});

// -- Rate Limit --
const rateLimitSchema = z.object({
  windowMs: z
    .number()
    .optional()
    .describe('Rate-limit window duration in milliseconds. Omit to use the middleware default.'),
  max: z
    .number()
    .optional()
    .describe(
      'Maximum requests allowed in one rate-limit window. Omit to use the middleware default.',
    ),
  message: z
    .string()
    .optional()
    .describe(
      'Error message returned when the rate limit is exceeded. Omit to use the middleware default message.',
    ),
  standardHeaders: z
    .boolean()
    .optional()
    .describe(
      'Whether standard rate-limit headers are emitted. Omit to use the middleware default.',
    ),
  keyGenerator: z
    .union([
      z
        .enum(['ip', 'user', 'ip+user'])
        .describe(
          'Built-in rate-limit key strategy. ' +
            '"ip" keys by client IP address (framework default). ' +
            '"user" keys by authenticated user ID (authUserId); unauthenticated requests use IP fallback. ' +
            '"ip+user" uses user ID when authenticated, IP when anonymous.',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe(
      'Rate-limit key generation strategy or handler reference. ' +
        'Omit to use the framework default (IP-based).',
    ),
  skip: z
    .union([
      z
        .enum(['authenticated'])
        .describe(
          'Built-in rate-limit skip strategy. ' +
            '"authenticated" skips rate limiting for requests with a valid authUserId.',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe(
      'Rate-limit skip strategy or handler reference. ' +
        'Omit to apply rate limits to every non-public request.',
    ),
  handler: appManifestHandlerRefSchema
    .optional()
    .describe(
      'Handler reference invoked when the rate limit is exceeded. Omit to use the middleware default handler.',
    ),
});

// -- Captcha --
const captchaSchema = z.object({
  provider: z.string().describe('Captcha provider name used to validate challenge tokens.'),
  secretKey: z
    .string()
    .describe('Secret key used to validate captcha tokens with the configured provider.'),
  minScore: z
    .number()
    .optional()
    .describe(
      'Minimum provider score accepted for score-based captchas. Omit to use the provider default threshold.',
    ),
  tokenField: z
    .string()
    .optional()
    .describe(
      'Request field carrying the captcha token. Omit to use the framework default token field.',
    ),
  adaptive: z
    .boolean()
    .optional()
    .describe(
      'Whether captcha challenges are enabled adaptively instead of on every request. Omit to use the framework default behavior.',
    ),
  adaptiveThreshold: z
    .number()
    .optional()
    .describe(
      'Risk threshold that triggers adaptive captcha enforcement. Omit to use the framework default threshold.',
    ),
});

// -- Bot Protection --
const botProtectionSchema = z.object({
  blockList: z
    .array(z.string())
    .optional()
    .describe(
      'Blocked user-agent or request fingerprint patterns. Omit to use no explicit block list.',
    ),
  fingerprintRateLimit: z
    .boolean()
    .optional()
    .describe(
      'Whether anonymous fingerprint-based rate limiting is enabled. Omit to use the framework default.',
    ),
});

// -- Security --
export const securitySectionSchema = z.object({
  cors: z
    .union([z.string(), z.array(z.string()), corsObjectSchema.loose()])
    .optional()
    .describe(
      'CORS configuration for the application. Omit to use the framework default CORS behavior.',
    ),
  headers: z
    .union([z.boolean(), z.record(z.string(), z.unknown())])
    .optional()
    .describe(
      'Security-header configuration or overrides. Omit to use the framework default headers.',
    ),
  rateLimit: z
    .union([rateLimitSchema.loose(), z.literal(false)])
    .optional()
    .describe(
      'Global rate-limiting configuration. Set false to disable rate limiting, or omit to use the framework default.',
    ),
  botProtection: z
    .union([botProtectionSchema.loose(), z.literal(false)])
    .optional()
    .describe(
      'Bot-protection settings. Set false to disable bot protection, or omit to use the framework default.',
    ),
  trustProxy: z
    .union([z.literal(false), z.number()])
    .optional()
    .describe(
      'Proxy trust setting for request IP and protocol resolution. Use false or a hop count. Omit to use the framework default.',
    ),
  signing: signingSchema
    .loose()
    .optional()
    .describe(
      'Signing settings for cookies, cursors, requests, and related tokens. Omit to use the framework defaults.',
    ),
  captcha: z
    .union([captchaSchema.loose(), z.literal(false)])
    .optional()
    .describe(
      'Captcha enforcement settings. Set false to disable captcha, or omit to use the framework default.',
    ),
});
