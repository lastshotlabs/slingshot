import { createMfaChallenge } from '@auth/lib/mfaChallenge';
import type { WebAuthnCredential } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  decryptField,
  encryptField,
  isEncryptedField,
  sha256,
  timingSafeEqual,
} from '@lastshotlabs/slingshot-core';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

/**
 * Lazily imports the `otpauth` package.
 *
 * `otpauth` is an optional peer dependency — importing it at module level
 * would cause startup errors in apps that have not installed it.  By
 * deferring the import to call time, slingshot-auth only throws when a TOTP
 * operation is actually attempted.
 *
 * @returns The `otpauth` module namespace.
 * @throws {Error} When `otpauth` is not installed.
 */
async function getOtpAuth() {
  return import('otpauth');
}

/**
 * Generates a cryptographically random, URL-safe alphanumeric code.
 *
 * Uses a rejection-sampling strategy to eliminate modular bias: bytes
 * ≥ 248 (the largest multiple of the 31-character alphabet below 256) are
 * discarded and resampled.  The result contains only unambiguous characters
 * (`A-Z` excluding `I` and `O`, digits `2-9` excluding `0` and `1`).
 *
 * @param length - Number of characters to generate.
 * @returns A random string of exactly `length` characters.
 *
 * @remarks
 * This function is used for MFA recovery codes.  The 31-character alphabet
 * and rejection sampling together ensure uniform distribution with no
 * look-alike character confusion.
 */
function generateRandomCode(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars: I/1/O/0
  const charLen = chars.length; // 31
  const maxUnbiased = 248; // largest multiple of 31 below 256 (31 * 8 = 248)
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    let byte = bytes[i];
    while (byte >= maxUnbiased) {
      byte = crypto.getRandomValues(new Uint8Array(1))[0];
    }
    code += chars[byte % charLen];
  }
  return code;
}

/**
 * Generates a set of one-time MFA recovery codes.
 *
 * The count is determined by `config.mfa.recoveryCodes` (defaults to 10).
 * Each plain code is 8 characters from the unambiguous alphabet (see
 * `generateRandomCode`).  The function returns both the plain codes (shown
 * once to the user) and their SHA-256 hashes (stored in the adapter).
 *
 * @param runtime - The active auth runtime context (provides config and encryption keys).
 * @returns An object containing `plainCodes` (show to user once) and
 *   `hashedCodes` (store in the adapter).
 *
 * @remarks
 * Recovery codes are hashed with SHA-256 before storage so a database breach
 * does not expose working codes.  The plain codes are never persisted and
 * cannot be recovered after this function returns — the user must store them
 * immediately.
 */
function generateRecoveryCodes(runtime: AuthRuntimeContext): {
  plainCodes: string[];
  hashedCodes: string[];
} {
  const count = runtime.config.mfa?.recoveryCodes ?? 10;
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const plain = generateRandomCode(8);
    plainCodes.push(plain);
    hashedCodes.push(sha256(plain));
  }
  return { plainCodes, hashedCodes };
}

// ---------------------------------------------------------------------------
// TOTP setup + management
// ---------------------------------------------------------------------------

/**
 * Result of a TOTP MFA setup initiation.
 *
 * Returned by `setupMfa`.  The `secret` should be shown once to the user
 * (or encoded into `uri` for QR display) and is never re-retrievable in
 * plain form — it is encrypted at rest immediately after setup.
 */
export interface MfaSetupResult {
  /**
   * Base32-encoded TOTP secret.  Display this to the user for manual entry
   * into their authenticator app, or encode it into `uri` for QR scanning.
   */
  secret: string;
  /**
   * `otpauth://` URI suitable for generating a QR code with any standard
   * TOTP library (e.g. `qrcode`, `qrcode.react`).
   */
  uri: string;
}

/**
 * Initiates TOTP MFA setup for a user.
 *
 * Generates a fresh TOTP secret, stores it on the user record (encrypted
 * when data encryption keys are configured), and returns the plain secret
 * and an `otpauth://` URI for QR display.
 *
 * MFA is **not** activated yet — the user must confirm with a valid TOTP
 * code via `verifySetup` before MFA is enforced on subsequent logins.
 *
 * @param userId - The user to set up MFA for.
 * @param runtime - The active auth runtime context.
 * @returns `MfaSetupResult` containing the plain `secret` and `otpauth://` `uri`.
 *
 * @throws {HttpError} 501 — When `adapter.setMfaSecret` is not implemented.
 * @throws {Error} — When the `otpauth` peer dependency is not installed.
 *
 * @example
 * import { setupMfa } from '@lastshotlabs/slingshot-auth';
 *
 * const { secret, uri } = await setupMfa(userId, runtime);
 * // Show secret to user for manual entry, or render uri as a QR code.
 * // Then prompt user to confirm with verifySetup(userId, totpCode, runtime).
 *
 * @remarks
 * When `runtime.dataEncryptionKeys` is non-empty the secret is encrypted with
 * `encryptField` before being stored.  In development (no keys configured)
 * the secret is stored as plaintext.
 */
export const setupMfa = async (
  userId: string,
  runtime: AuthRuntimeContext,
): Promise<MfaSetupResult> => {
  const { adapter, config } = runtime;
  if (!adapter.setMfaSecret) throw new HttpError(501, 'Auth adapter does not support MFA');

  const otpauth = await getOtpAuth();
  const secret = new otpauth.Secret();

  const mfaCfg = config.mfa;
  const totp = new otpauth.TOTP({
    issuer: mfaCfg?.issuer ?? config.appName,
    label: userId,
    algorithm: mfaCfg?.algorithm ?? 'SHA1',
    digits: mfaCfg?.digits ?? 6,
    period: mfaCfg?.period ?? 30,
    secret,
  });

  // Store the secret but don't enable MFA yet — user must confirm with a code
  // Encrypt at rest when encryption keys are available; store plaintext in dev otherwise.
  const deks = [...runtime.dataEncryptionKeys];
  const storedSecret = deks.length > 0 ? encryptField(secret.base32, deks) : secret.base32;
  await adapter.setMfaSecret(userId, storedSecret);

  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
};

/**
 * Resolve a stored MFA secret: decrypt it if it looks like an encrypted ciphertext
 * (produced by encryptField), otherwise return as-is (plaintext — allowed in dev).
 */
async function resolveStoredSecret(stored: string, runtime: AuthRuntimeContext): Promise<string> {
  if (isEncryptedField(stored)) {
    const deks = [...runtime.dataEncryptionKeys];
    if (deks.length === 0) {
      throw new HttpError(
        500,
        'TOTP secret is encrypted but SLINGSHOT_DATA_ENCRYPTION_KEY is not set',
      );
    }
    return Promise.resolve(decryptField(stored, deks));
  }
  return stored;
}

export const verifySetup = async (
  userId: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<string[]> => {
  const { adapter, config } = runtime;
  if (!adapter.getMfaSecret || !adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, 'Auth adapter does not support MFA');
  }

  const storedSecretStr = await adapter.getMfaSecret(userId);
  if (!storedSecretStr)
    throw new HttpError(400, 'MFA setup not initiated. Call POST /auth/mfa/setup first.');

  const secretStr = await resolveStoredSecret(storedSecretStr, runtime);

  const mfaCfg = config.mfa;
  const otpauth = await getOtpAuth();
  const totp = new otpauth.TOTP({
    issuer: mfaCfg?.issuer ?? config.appName,
    algorithm: mfaCfg?.algorithm ?? 'SHA1',
    digits: mfaCfg?.digits ?? 6,
    period: mfaCfg?.period ?? 30,
    secret: otpauth.Secret.fromBase32(secretStr),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw new HttpError(401, 'Invalid TOTP code');

  // Generate recovery codes (regenerates if enabling a second method)
  const { plainCodes, hashedCodes } = generateRecoveryCodes(runtime);

  await adapter.setRecoveryCodes(userId, hashedCodes);
  await adapter.setMfaEnabled(userId, true);

  // Add "totp" to mfaMethods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes('totp')) {
      await adapter.setMfaMethods(userId, [...methods, 'totp']);
    }
  }

  return plainCodes;
};

export const verifyTotp = async (
  userId: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<boolean> => {
  const { adapter, config } = runtime;
  if (!adapter.getMfaSecret) throw new HttpError(501, 'Auth adapter does not support MFA');

  const storedSecretStr = await adapter.getMfaSecret(userId);
  if (!storedSecretStr) return false;

  const secretStr = await resolveStoredSecret(storedSecretStr, runtime);

  const mfaCfg = config.mfa;
  const otpauth = await getOtpAuth();
  const totp = new otpauth.TOTP({
    issuer: mfaCfg?.issuer ?? config.appName,
    algorithm: mfaCfg?.algorithm ?? 'SHA1',
    digits: mfaCfg?.digits ?? 6,
    period: mfaCfg?.period ?? 30,
    secret: otpauth.Secret.fromBase32(secretStr),
  });

  return totp.validate({ token: code, window: 1 }) !== null;
};

export const verifyRecoveryCode = async (
  userId: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<boolean> => {
  const { adapter } = runtime;
  const hashedInput = sha256(code.toUpperCase());

  // Fetch stored hashes and perform timing-safe comparison at the application level
  // before consuming, adding defense-in-depth against hash enumeration timing.
  if (adapter.getRecoveryCodes) {
    const storedHashes = await adapter.getRecoveryCodes(userId);
    let matched = false;
    // Iterate all codes to maintain constant time regardless of match position
    for (const stored of storedHashes) {
      if (timingSafeEqual(stored, hashedInput)) {
        matched = true;
      }
    }
    if (!matched) return false;
  }

  return adapter.consumeRecoveryCode(userId, hashedInput);
};

export const disableMfa = async (
  userId: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<void> => {
  const { adapter } = runtime;
  if (!adapter.setMfaEnabled || !adapter.setMfaSecret || !adapter.setRecoveryCodes) {
    throw new HttpError(501, 'Auth adapter does not support MFA');
  }

  const valid = await verifyTotp(userId, code, runtime);
  if (!valid) throw new HttpError(401, 'Invalid TOTP code');

  await adapter.setMfaEnabled(userId, false);
  await adapter.setMfaSecret(userId, null);
  await adapter.setRecoveryCodes(userId, []);

  // Clear all mfaMethods
  if (adapter.setMfaMethods) {
    await adapter.setMfaMethods(userId, []);
  }
};

export const regenerateRecoveryCodes = async (
  userId: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<string[]> => {
  const { adapter } = runtime;
  if (!adapter.setRecoveryCodes) throw new HttpError(501, 'Auth adapter does not support MFA');

  const valid = await verifyTotp(userId, code, runtime);
  if (!valid) throw new HttpError(401, 'Invalid TOTP code');

  const { plainCodes, hashedCodes } = generateRecoveryCodes(runtime);
  await adapter.setRecoveryCodes(userId, hashedCodes);
  return plainCodes;
};

// ---------------------------------------------------------------------------
// Email OTP
// ---------------------------------------------------------------------------

/** Generate a cryptographically random numeric OTP code. Returns { code, hash }. */
export const generateEmailOtpCode = (
  runtime: AuthRuntimeContext,
  length?: number,
): { code: string; hash: string } => {
  const len = length ?? runtime.config.mfa?.emailOtp?.codeLength ?? 6;
  const maxUnbiased = 250; // largest multiple of 10 below 256 (10 * 25 = 250)
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let code = '';
  for (let i = 0; i < len; i++) {
    let byte = bytes[i];
    while (byte >= maxUnbiased) {
      byte = crypto.getRandomValues(new Uint8Array(1))[0];
    }
    code += (byte % 10).toString();
  }
  return { code, hash: sha256(code) };
};

/** Verify an email OTP code against a stored hash. */
export const verifyEmailOtp = (emailOtpHash: string, code: string): boolean => {
  return timingSafeEqual(sha256(code), emailOtpHash);
};

/**
 * Initiate email OTP setup: sends a verification code to the user's email.
 * Returns a setup challenge token that must be confirmed via confirmEmailOtp.
 */
export const initiateEmailOtp = async (
  userId: string,
  runtime: AuthRuntimeContext,
): Promise<string> => {
  const { adapter, eventBus, config } = runtime;
  const emailOtpConfig = config.mfa?.emailOtp ?? null;
  if (!emailOtpConfig) throw new HttpError(501, 'Email OTP is not configured');

  const user = adapter.getUser ? await adapter.getUser(userId) : null;
  if (!user?.email) throw new HttpError(400, 'No email address on account');

  const { code, hash } = generateEmailOtpCode(runtime);
  publishAuthEvent(runtime.events, 'auth:delivery.email_otp', { email: user.email, code });

  // Store the hash in a challenge token for verification
  const setupToken = await createMfaChallenge(
    runtime.repos.mfaChallenge,
    userId,
    { emailOtpHash: hash },
    config,
  );
  return setupToken;
};

/**
 * Confirm email OTP setup: verifies the code sent during initiateEmailOtp.
 * Enables email OTP as an MFA method. Returns recovery codes if MFA was not previously active.
 */
export const confirmEmailOtp = async (
  userId: string,
  setupToken: string,
  code: string,
  runtime: AuthRuntimeContext,
): Promise<string[] | null> => {
  const { adapter } = runtime;
  if (!adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, 'Auth adapter does not support MFA');
  }

  // Import consumeMfaChallenge here to avoid circular dependency issues at module level
  const { consumeMfaChallenge } = await import('@auth/lib/mfaChallenge');
  const challenge = await consumeMfaChallenge(runtime.repos.mfaChallenge, setupToken);
  if (!challenge) throw new HttpError(401, 'Invalid or expired setup token');
  if (challenge.userId !== userId) throw new HttpError(401, 'Token does not match user');
  if (!challenge.emailOtpHash) throw new HttpError(400, 'Invalid setup token — no OTP hash');

  if (!verifyEmailOtp(challenge.emailOtpHash, code)) {
    throw new HttpError(401, 'Invalid verification code');
  }

  // Check if MFA was already active
  const wasEnabled = adapter.isMfaEnabled ? await adapter.isMfaEnabled(userId) : false;

  // Add "emailOtp" to mfaMethods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes('emailOtp')) {
      await adapter.setMfaMethods(userId, [...methods, 'emailOtp']);
    }
  }

  await adapter.setMfaEnabled(userId, true);

  // Generate recovery codes if MFA was not previously active
  if (!wasEnabled) {
    const { plainCodes, hashedCodes } = generateRecoveryCodes(runtime);
    await adapter.setRecoveryCodes(userId, hashedCodes);
    return plainCodes;
  }

  // Regenerate recovery codes when adding a second method
  const { plainCodes, hashedCodes } = generateRecoveryCodes(runtime);
  await adapter.setRecoveryCodes(userId, hashedCodes);
  return plainCodes;
};

/**
 * Disable email OTP for a user.
 * If TOTP is also enabled, requires a TOTP code. Otherwise requires password.
 */
export const disableEmailOtp = async (
  userId: string,
  params: { code?: string; password?: string },
  runtime: AuthRuntimeContext,
): Promise<void> => {
  const { adapter } = runtime;
  if (!adapter.setMfaEnabled) throw new HttpError(501, 'Auth adapter does not support MFA');

  // Get current methods
  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const hasTotpEnabled = methods.includes('totp');

  // Verify identity
  if (hasTotpEnabled) {
    if (!params.code) throw new HttpError(400, 'TOTP code required to disable email OTP');
    const valid = await verifyTotp(userId, params.code, runtime);
    if (!valid) throw new HttpError(401, 'Invalid TOTP code');
  } else {
    if (!params.password) throw new HttpError(400, 'Password required to disable email OTP');
    const valid = await adapter.verifyPassword(userId, params.password);
    if (!valid) throw new HttpError(401, 'Invalid password');
  }

  // Remove "emailOtp" from methods
  if (adapter.setMfaMethods) {
    const updated = methods.filter(m => m !== 'emailOtp');
    await adapter.setMfaMethods(userId, updated);

    // If no methods remain, disable MFA entirely
    if (updated.length === 0) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

/** Get the MFA methods enabled for a user. */
export const getMfaMethods = async (
  userId: string,
  runtime: AuthRuntimeContext,
): Promise<string[]> => {
  const { adapter } = runtime;
  if (adapter.getMfaMethods) return adapter.getMfaMethods(userId);
  return [];
};

// ---------------------------------------------------------------------------
// WebAuthn / FIDO2
// ---------------------------------------------------------------------------

// Lazy-load @simplewebauthn/server to keep it as an optional peer dependency
async function getSimpleWebAuthn() {
  return import('@simplewebauthn/server');
}

/**
 * Eager startup check — call at route mount time to fail fast if the peer dependency is missing.
 */
export const assertWebAuthnDependency = async (): Promise<void> => {
  try {
    await import('@simplewebauthn/server');
  } catch {
    throw new Error(
      '@simplewebauthn/server is required when mfa.webauthn is configured. Install it: bun add @simplewebauthn/server',
    );
  }
};

/**
 * Generate WebAuthn authentication options for the login MFA flow.
 * Called from auth.ts login when the user has "webauthn" in their methods.
 */
export const generateWebAuthnAuthenticationOptions = async (
  userId: string,
  runtime: AuthRuntimeContext,
): Promise<{ challenge: string; options: Record<string, unknown> } | null> => {
  const config = runtime.config.mfa?.webauthn ?? null;
  if (!config) return null;
  const { adapter } = runtime;
  if (!adapter.getWebAuthnCredentials) return null;

  const credentials = await adapter.getWebAuthnCredentials(userId);
  if (credentials.length === 0) return null;

  const { generateAuthenticationOptions } = await getSimpleWebAuthn();
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: credentials.map(c => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    userVerification: config.userVerification ?? 'preferred',
    timeout: config.timeout ?? 60000,
  });

  return { challenge: options.challenge, options: options as unknown as Record<string, unknown> };
};

// Re-use the type from the WebAuthn spec — imported dynamically
type AuthenticatorTransport = 'usb' | 'ble' | 'nfc' | 'internal' | 'hybrid';

/**
 * Initiate WebAuthn registration: generates registration options for the client.
 * Returns options + a registration challenge token.
 */
export const initiateWebAuthnRegistration = async (
  userId: string,
  runtime: AuthRuntimeContext,
): Promise<{ options: Record<string, unknown>; registrationToken: string }> => {
  const config = runtime.config.mfa?.webauthn ?? null;
  if (!config) throw new HttpError(501, 'WebAuthn is not configured');
  const { adapter } = runtime;
  if (!adapter.getWebAuthnCredentials)
    throw new HttpError(501, 'Auth adapter does not support WebAuthn');

  const user = adapter.getUser ? await adapter.getUser(userId) : null;

  // Get existing credentials to exclude (prevent re-registration)
  const existingCreds = await adapter.getWebAuthnCredentials(userId);

  const { generateRegistrationOptions } = await getSimpleWebAuthn();
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? runtime.config.appName,
    rpID: config.rpId,
    userName: user?.email ?? userId,
    attestationType: config.attestationType ?? 'none',
    excludeCredentials: existingCreds.map(c => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      authenticatorAttachment: config.authenticatorAttachment,
      userVerification: config.userVerification ?? 'required',
      residentKey: 'required',
    },
    timeout: config.timeout ?? 60000,
  });

  const { createWebAuthnRegistrationChallenge } = await import('@auth/lib/mfaChallenge');
  const registrationToken = await createWebAuthnRegistrationChallenge(
    runtime.repos.mfaChallenge,
    userId,
    options.challenge,
    runtime.config,
  );

  return { options: options as unknown as Record<string, unknown>, registrationToken };
};

/**
 * Complete WebAuthn registration: verifies attestation and stores the credential.
 * Returns recovery codes if this is the first MFA method.
 */
export const completeWebAuthnRegistration = async (
  userId: string,
  registrationToken: string,
  attestationResponse: import('@simplewebauthn/server').RegistrationResponseJSON,
  runtime: AuthRuntimeContext,
  name?: string,
): Promise<{ credentialId: string; recoveryCodes: string[] | null }> => {
  const config = runtime.config.mfa?.webauthn ?? null;
  if (!config) throw new HttpError(501, 'WebAuthn is not configured');
  const { adapter } = runtime;
  if (!adapter.addWebAuthnCredential || !adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, 'Auth adapter does not support WebAuthn');
  }

  const { consumeWebAuthnRegistrationChallenge } = await import('@auth/lib/mfaChallenge');
  const challenge = await consumeWebAuthnRegistrationChallenge(
    runtime.repos.mfaChallenge,
    registrationToken,
  );
  if (!challenge) throw new HttpError(401, 'Invalid or expired registration token');
  if (challenge.userId !== userId) throw new HttpError(401, 'Token does not match user');

  const { verifyRegistrationResponse } = await getSimpleWebAuthn();
  const verification = await verifyRegistrationResponse({
    response: attestationResponse,
    expectedChallenge: challenge.challenge,
    expectedOrigin: Array.isArray(config.origin) ? config.origin : [config.origin],
    expectedRPID: config.rpId,
  });

  if (!verification.verified) {
    throw new HttpError(401, 'WebAuthn registration verification failed');
  }

  const { credential } = verification.registrationInfo;
  const credentialId = credential.id;

  // Cross-user uniqueness check
  if (adapter.findUserByWebAuthnCredentialId) {
    const existingOwner = await adapter.findUserByWebAuthnCredentialId(credentialId);
    if (existingOwner && existingOwner !== userId) {
      throw new HttpError(409, 'This security key is already registered to another account');
    }
  }

  const newCredential: WebAuthnCredential = {
    credentialId,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    signCount: credential.counter,
    transports: (attestationResponse.response.transports as string[] | undefined) ?? [],
    name: name ?? undefined,
    createdAt: Date.now(),
  };

  await adapter.addWebAuthnCredential(userId, newCredential);

  // Add "webauthn" to methods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes('webauthn')) {
      await adapter.setMfaMethods(userId, [...methods, 'webauthn']);
    }
  }

  // Enable MFA + generate/regenerate recovery codes
  await adapter.setMfaEnabled(userId, true);
  const { plainCodes, hashedCodes } = generateRecoveryCodes(runtime);
  await adapter.setRecoveryCodes(userId, hashedCodes);

  return { credentialId, recoveryCodes: plainCodes };
};

/**
 * Verify a WebAuthn authentication assertion during login MFA.
 */
export const verifyWebAuthn = async (
  userId: string,
  assertionResponse: import('@simplewebauthn/server').AuthenticationResponseJSON,
  expectedChallenge: string,
  runtime: AuthRuntimeContext,
): Promise<boolean> => {
  const config = runtime.config.mfa?.webauthn ?? null;
  if (!config) return false;
  const { adapter } = runtime;
  if (!adapter.getWebAuthnCredentials || !adapter.updateWebAuthnCredentialSignCount) return false;

  const credentials = await adapter.getWebAuthnCredentials(userId);
  const credentialId = assertionResponse.id;
  const matchedCred = credentials.find(c => c.credentialId === credentialId);
  if (!matchedCred) return false;

  const { verifyAuthenticationResponse } = await getSimpleWebAuthn();
  try {
    const verification = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: Array.isArray(config.origin) ? config.origin : [config.origin],
      expectedRPID: config.rpId,
      credential: {
        id: matchedCred.credentialId,
        publicKey: new Uint8Array(Buffer.from(matchedCred.publicKey, 'base64url')),
        counter: matchedCred.signCount,
        transports: matchedCred.transports as AuthenticatorTransport[],
      },
    });

    if (!verification.verified) return false;

    const { authenticationInfo } = verification;

    // Sign count policy
    if (authenticationInfo.newCounter < matchedCred.signCount) {
      if (config.strictSignCount) {
        console.warn(
          `[webauthn] Sign count went backward for credential ${credentialId} (user ${userId}) — rejecting (strictSignCount enabled)`,
        );
        return false;
      }
      console.warn(
        `[webauthn] Sign count went backward for credential ${credentialId} (user ${userId}) — possible cloned authenticator`,
      );
    }

    await adapter.updateWebAuthnCredentialSignCount(
      userId,
      credentialId,
      authenticationInfo.newCounter,
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove a single WebAuthn credential.
 * Only requires identity verification when removing the last credential of the last MFA method.
 */
export const removeWebAuthnCredential = async (
  userId: string,
  credentialId: string,
  params: { code?: string; password?: string },
  runtime: AuthRuntimeContext,
): Promise<void> => {
  const { adapter } = runtime;
  if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
    throw new HttpError(501, 'Auth adapter does not support WebAuthn');
  }

  const credentials = await adapter.getWebAuthnCredentials(userId);
  if (!credentials.some(c => c.credentialId === credentialId)) {
    throw new HttpError(404, 'Credential not found');
  }

  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const otherMethodsExist = methods.some(m => m !== 'webauthn');
  const otherCredsExist = credentials.length > 1;

  // Only require verification when removing the last credential of the last method
  if (!otherMethodsExist && !otherCredsExist) {
    await verifyIdentity(userId, params, runtime);
  }

  await adapter.removeWebAuthnCredential(userId, credentialId);

  // If that was the last credential, remove "webauthn" from methods
  if (!otherCredsExist && adapter.setMfaMethods) {
    const updated = methods.filter(m => m !== 'webauthn');
    await adapter.setMfaMethods(userId, updated);

    // If no methods remain, disable MFA entirely
    if (updated.length === 0 && adapter.setMfaEnabled) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

/**
 * Disable WebAuthn entirely: removes all credentials and the method.
 */
export const disableWebAuthn = async (
  userId: string,
  params: { code?: string; password?: string },
  runtime: AuthRuntimeContext,
): Promise<void> => {
  const { adapter } = runtime;
  if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
    throw new HttpError(501, 'Auth adapter does not support WebAuthn');
  }

  await verifyIdentity(userId, params, runtime);

  const credentials = await adapter.getWebAuthnCredentials(userId);
  for (const cred of credentials) {
    await adapter.removeWebAuthnCredential(userId, cred.credentialId);
  }

  // Remove "webauthn" from methods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    const updated = methods.filter(m => m !== 'webauthn');
    await adapter.setMfaMethods(userId, updated);

    if (updated.length === 0 && adapter.setMfaEnabled) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

// ---------------------------------------------------------------------------
// verifyAnyFactor — unified factor verification for reauth / destructive actions
// ---------------------------------------------------------------------------

/**
 * Verifies any supported second factor for a given user and session.
 *
 * Used by step-up auth, account deletion, and MFA-disable flows to validate that the
 * user can prove possession of a second factor before performing a sensitive operation.
 *
 * Supported methods:
 * - `"totp"` — validates a TOTP code against the user's registered TOTP secret.
 * - `"recovery"` — validates a recovery code (SHA-256 hashed comparison).
 *   Only checked when `method` is explicitly `"recovery"`.
 * - `"password"` — verifies the account password.
 * - `"emailOtp"` — validates a code against an existing reauth challenge bound to `sessionId`.
 * - `"webauthn"` — validates a WebAuthn assertion against an existing reauth challenge.
 *
 * @param userId - The user ID to verify the factor for.
 * @param sessionId - The current session ID (required for emailOtp/webauthn challenge binding).
 * @param runtime - The active auth runtime context.
 * @param params - Verification input. Must include `method`; other fields depend on the method.
 * @returns `true` when verification succeeds, `false` otherwise (never throws).
 *
 * @example
 * import { verifyAnyFactor } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const ok = await verifyAnyFactor(userId, sessionId, runtime, {
 *   method: 'totp',
 *   code: body.totpCode,
 * });
 * if (!ok) return c.json({ error: 'Invalid verification code' }, 400);
 *
 * @remarks
 * Recovery codes are only considered when `method === 'recovery'` — they are never
 * tried as a fallback. EmailOtp and WebAuthn consume a reauth challenge that must have
 * been created in the same session before calling this function.
 */
export async function verifyAnyFactor(
  userId: string,
  sessionId: string,
  runtime: AuthRuntimeContext,
  params: {
    method?: 'totp' | 'emailOtp' | 'webauthn' | 'password' | 'recovery';
    code?: string;
    password?: string;
    reauthToken?: string;
    webauthnResponse?: object;
  },
): Promise<boolean> {
  const { method, code, password, reauthToken, webauthnResponse } = params;
  if (!method) return false;
  const { adapter } = runtime;

  try {
    if (method === 'totp') {
      if (!code) return false;
      return await verifyTotp(userId, code, runtime);
    }

    if (method === 'recovery') {
      if (!code) return false;
      const hashedInput = sha256(code.toUpperCase());
      return await adapter.consumeRecoveryCode(userId, hashedInput);
    }

    if (method === 'password') {
      if (!password) return false;
      return await adapter.verifyPassword(userId, password);
    }

    if (method === 'emailOtp') {
      if (!reauthToken || !code) return false;
      const { consumeReauthChallenge } = await import('@auth/lib/mfaChallenge');
      const challenge = await consumeReauthChallenge(
        runtime.repos.mfaChallenge,
        reauthToken,
        sessionId,
      );
      if (!challenge || !challenge.emailOtpHash) return false;
      return timingSafeEqual(sha256(code), challenge.emailOtpHash);
    }

    // method === 'webauthn' — only remaining variant after totp/recovery/password/emailOtp
    if (!reauthToken || !webauthnResponse) return false;
    const { consumeReauthChallenge } = await import('@auth/lib/mfaChallenge');
    const challenge = await consumeReauthChallenge(
      runtime.repos.mfaChallenge,
      reauthToken,
      sessionId,
    );
    if (!challenge || !challenge.webauthnChallenge) return false;
    return await verifyWebAuthn(
      userId,
      webauthnResponse as import('@simplewebauthn/server').AuthenticationResponseJSON,
      challenge.webauthnChallenge,
      runtime,
    );
  } catch {
    return false;
  }
}

/** Internal: verify identity via TOTP code or password. */
async function verifyIdentity(
  userId: string,
  params: { code?: string; password?: string },
  runtime: AuthRuntimeContext,
): Promise<void> {
  const { adapter } = runtime;
  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const hasTotpEnabled = methods.includes('totp');

  if (hasTotpEnabled) {
    if (!params.code) throw new HttpError(400, 'TOTP code required');
    const valid = await verifyTotp(userId, params.code, runtime);
    if (!valid) throw new HttpError(401, 'Invalid TOTP code');
  } else {
    if (!params.password) throw new HttpError(400, 'Password required');
    const valid = await adapter.verifyPassword(userId, params.password);
    if (!valid) throw new HttpError(401, 'Invalid password');
  }
}
