import { SuccessResponse } from '@auth/schemas/success';
import { z } from 'zod';
import type { PasswordPolicyConfig, PrimaryField } from '../config/authConfig';

const passwordSchema = (policy: PasswordPolicyConfig) => {
  const minLen = policy.minLength ?? 8;
  let schema = z.string().min(minLen, `Password must be at least ${minLen} characters`);

  if (policy.requireLetter !== false) {
    schema = schema.regex(/[a-zA-Z]/, 'Password must contain at least one letter');
  }
  if (policy.requireDigit !== false) {
    schema = schema.regex(/\d/, 'Password must contain at least one digit');
  }
  if (policy.requireSpecial) {
    schema = schema.regex(/[^a-zA-Z0-9]/, 'Password must contain at least one special character');
  }
  return schema;
};

/**
 * Creates a Zod validation schema for the registration request body.
 *
 * The schema contains two fields: the primary identity field and `password`. The primary
 * field is validated as `email` (RFC 5321 format, max 256 chars) when `primaryField` is
 * `'email'`, or as a plain string (min 3, max 256) for `username`/`phone` fields.
 * The password is validated against the supplied policy (min length, letter, digit, special
 * character requirements) with an additional 128-character maximum to cap bcrypt input.
 *
 * @param primaryField - The primary login field type (`'email'`, `'username'`, or `'phone'`).
 * @param policy - The password policy config controlling minimum length and complexity rules.
 * @returns A Zod object schema for the `POST /auth/register` request body.
 *
 * @example
 * import { createRegisterSchema } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const schema = createRegisterSchema('email', { minLength: 10, requireSpecial: true });
 * const result = schema.safeParse({ email: 'alice@example.com', password: 'Str0ng!Pass' });
 */
export const createRegisterSchema = (primaryField: PrimaryField, policy: PasswordPolicyConfig) =>
  z.object({
    [primaryField]: primaryField === 'email' ? z.email().max(256) : z.string().min(3).max(256),
    password: passwordSchema(policy).max(128),
  });

/**
 * Creates a Zod validation schema for the login request body.
 *
 * Validates the primary identity field and a `password` field. The identity field
 * uses email format validation when `primaryField` is `'email'`; for other field types
 * it only requires a non-empty string (max 256 chars). The password field requires a
 * non-empty string (max 128 chars) without complexity rules — complexity is enforced at
 * registration time only.
 *
 * @param primaryField - The primary login field type (`'email'`, `'username'`, or `'phone'`).
 * @returns A Zod object schema for the `POST /auth/login` request body.
 *
 * @example
 * import { createLoginSchema } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const schema = createLoginSchema('email');
 * const result = schema.safeParse({ email: 'alice@example.com', password: 'mypassword' });
 */
export const createLoginSchema = (primaryField: PrimaryField) =>
  z.object({
    [primaryField]: primaryField === 'email' ? z.email().max(256) : z.string().min(1).max(256),
    password: z.string().min(1).max(128),
  });

/**
 * Creates a Zod validation schema for a standalone password field.
 *
 * Enforces the policy's minimum length, letter requirement, digit requirement, and optional
 * special-character requirement. No `max` is applied here — callers composing this into
 * request bodies should chain `.max(128)` to cap bcrypt input length.
 *
 * Used standalone for password change and password reset flows where only the new password
 * field needs to be validated independently (not composed with a primary identity field).
 *
 * @param policy - The password policy config controlling minimum length and complexity rules.
 * @returns A Zod string schema that validates a single password value.
 *
 * @example
 * import { createPasswordSchema } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const schema = z.object({
 *   currentPassword: z.string().min(1),
 *   newPassword: createPasswordSchema(policy).max(128),
 * });
 */
export const createPasswordSchema = (policy: PasswordPolicyConfig) => passwordSchema(policy);

export const TokenResponse = z
  .object({
    token: z
      .string()
      .describe(
        'JWT session token. Also set as an HttpOnly session cookie. Empty string when mfaRequired is true.',
      ),
    userId: z.string().describe('Unique user ID.'),
    email: z
      .string()
      .optional()
      .describe("User's email address (present when primaryField is 'email')."),
    emailVerified: z
      .boolean()
      .optional()
      .describe(
        'Whether the email address has been verified (present when emailVerification is configured).',
      ),
    googleLinked: z
      .boolean()
      .optional()
      .describe('Whether a Google OAuth account is linked to this user.'),
    refreshToken: z
      .string()
      .optional()
      .describe(
        'Refresh token (present when refreshTokens is configured). Also set as an HttpOnly cookie.',
      ),
    mfaRequired: z
      .boolean()
      .optional()
      .describe('When true, complete MFA via POST /auth/mfa/verify before accessing the API.'),
    mfaToken: z
      .string()
      .optional()
      .describe('MFA challenge token. Pass to POST /auth/mfa/verify with a TOTP or recovery code.'),
    mfaMethods: z
      .array(z.string())
      .optional()
      .describe(
        "Available MFA methods when mfaRequired is true (e.g., 'totp', 'emailOtp', 'webauthn').",
      ),
    webauthnOptions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "WebAuthn assertion options (present when mfaMethods includes 'webauthn'). Pass directly to navigator.credentials.get().",
      ),
  })
  .openapi('TokenResponse');

export const PasswordUpdateResponse = SuccessResponse.extend({
  token: z.string().optional().describe('Replacement session token when sessions are reissued.'),
}).openapi('PasswordUpdateResponse');

export const SessionInfoSchema = z
  .object({
    sessionId: z.string().describe('Unique session identifier (UUID).'),
    createdAt: z.number().describe('Unix timestamp (ms) when the session was created.'),
    lastActiveAt: z
      .number()
      .describe(
        'Unix timestamp (ms) of the most recent authenticated request (updated when trackLastActive is enabled).',
      ),
    expiresAt: z.number().describe('Unix timestamp (ms) when the session expires.'),
    ipAddress: z.string().optional().describe('IP address of the client at session creation.'),
    userAgent: z
      .string()
      .optional()
      .describe('User-agent string of the client at session creation.'),
    isActive: z.boolean().describe('Whether the session is currently valid and unexpired.'),
  })
  .openapi('SessionInfo');

// Used inline in account deletion, step-up — not given an openapi name
export const verificationSchema = z.object({
  method: z
    .enum(['totp', 'emailOtp', 'webauthn', 'password', 'recovery'])
    .optional()
    .describe('Verification method to use.'),
  code: z.string().optional().describe('TOTP code, email OTP code, or recovery code.'),
  password: z.string().optional().describe('Account password.'),
  reauthToken: z
    .string()
    .optional()
    .describe('Reauth challenge token (required for emailOtp and webauthn methods).'),
  webauthnResponse: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('WebAuthn assertion response (required for webauthn method).'),
});
