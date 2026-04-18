// Framework-level signing configuration — context-aware access only.
// Auth-specific config (JWT, sessions, MFA, etc.) lives in authConfig.ts.
//
// Phase 1 singleton elimination: all module-level mutable state removed.
// Signing config is available on SlingshotContext.signing.
import type { DataEncryptionKey } from '@lastshotlabs/slingshot-core';

export type { DataEncryptionKey };

// ---------------------------------------------------------------------------
// Signing config type
// ---------------------------------------------------------------------------

export interface SigningConfig {
  /**
   * HMAC secret. Defaults to JWT_SECRET env var if omitted.
   * Pass string[] to support key rotation - first element signs, all elements verify.
   */
  secret?: string | string[];
  /** Sign/verify cookie values set via exported helpers. Default: false. */
  cookies?: boolean;
  /** Sign pagination cursor tokens to prevent client tampering. Default: false. */
  cursors?: boolean;
  /** HMAC-based stateless presigned URLs (no DB lookup). Default: false. */
  presignedUrls?: boolean | { defaultExpiry?: number };
  /** Require clients to HMAC-sign requests (method+path+timestamp+body). Default: false. */
  requestSigning?:
    | boolean
    | {
        tolerance?: number;
        header?: string;
        timestampHeader?: string;
      };
  /** Hash idempotency keys before storage. Default: false. */
  idempotencyKeys?: boolean;
  /** Bind sessions to client IP+UA fingerprint. Default: false. */
  sessionBinding?:
    | boolean
    | {
        fields?: Array<'ip' | 'ua' | 'accept-language'>;
        onMismatch?: 'unauthenticate' | 'reject' | 'log-only';
      };
}

// ---------------------------------------------------------------------------
// Data encryption keys (AES-256-GCM for field-level encryption at rest)
// ---------------------------------------------------------------------------

/**
 * Parse data encryption keys from a raw string value resolved by the SecretRepository.
 *
 * Format: comma-separated "keyId:base64key" pairs, first is active.
 * Example: "v1:base64key1,v0:base64key0"
 * Returns [] when empty or not provided.
 *
 * @param rawValue Value resolved by SecretRepository. No process.env fallback.
 */
export function getDataEncryptionKeys(rawValue?: string): DataEncryptionKey[] {
  const raw = rawValue ?? '';
  if (!raw.trim()) return [];
  return raw.split(',').map(entry => {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1)
      throw new Error(
        `getDataEncryptionKeys: invalid entry "${entry}" - expected "keyId:base64key"`,
      );
    const keyId = entry.slice(0, colonIdx).trim();
    const keyBase64 = entry.slice(colonIdx + 1).trim();
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32)
      throw new Error(`getDataEncryptionKeys: key "${keyId}" must be 32 bytes (got ${key.length})`);
    return { keyId, key };
  });
}
