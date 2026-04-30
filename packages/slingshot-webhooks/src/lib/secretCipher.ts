import { type CipherGCMTypes, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WebhookCipherError } from '../errors/webhookErrors';

const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'enc:v1:';

/**
 * Pluggable encryptor for at-rest webhook endpoint secrets.
 *
 * Apps can supply a custom implementation backed by KMS, HashiCorp Vault, or
 * any other key manager. The default implementation built from
 * {@link createSecretCipher} performs local AES-256-GCM with a base64 key, but
 * the framework only depends on this interface so an external provider can be
 * dropped in without touching the storage path.
 *
 * Implementations should:
 * - Return strings that round-trip through {@link decrypt} unchanged.
 * - Tolerate values produced before encryption was enabled (the local
 *   implementation passes such values through and operators rotate by re-saving).
 *
 * `encrypt`/`decrypt` may be sync or async; the runtime awaits both.
 */
export interface SecretEncryptor {
  /** Encrypt a plaintext secret for at-rest storage. */
  encrypt(plaintext: string): string | Promise<string>;
  /** Decrypt a stored secret produced by {@link encrypt} or a legacy plaintext. */
  decrypt(stored: string): string | Promise<string>;
}

/**
 * AES-256-GCM cipher for at-rest webhook endpoint secrets.
 *
 * Plaintexts are written as `enc:v1:<iv-b64>:<ciphertext-b64>:<tag-b64>`. When
 * the cipher is created with no key (or with an explicit `null` key), it acts
 * as a no-op passthrough — used in test fixtures and during the migration
 * window before operators provision an encryption key.
 *
 * Legacy plaintext values that pre-date encryption are detected by the missing
 * `enc:v1:` prefix and returned unchanged from {@link decrypt}. Operators
 * should rotate those rows by writing the same value back through the update
 * path, which re-encrypts on write.
 */
export interface SecretCipher extends SecretEncryptor {
  /** Encrypt a plaintext secret. Returns the input unchanged when no key is configured. */
  encrypt(plaintext: string): string;
  /** Decrypt a stored secret. Tolerates legacy plaintext values without the prefix. */
  decrypt(stored: string): string;
  /** Whether the cipher has a real key configured. */
  readonly enabled: boolean;
}

/**
 * Decode a base64 or base64url-encoded 32-byte key.
 *
 * @throws {Error} When the decoded length is not 32 bytes.
 */
function decodeKey(encoded: string): Buffer {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new WebhookCipherError(
      `secretEncryptionKey must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

/**
 * Wrap an arbitrary {@link SecretEncryptor} so the runtime always sees an async
 * adapter shape. Used when an app supplies its own KMS-backed implementation
 * via plugin config.
 *
 * Pre-existing plaintext values (no `enc:v1:` prefix) are still tolerated by
 * the wrapper itself — it delegates straight to the encryptor on read so the
 * encryptor decides what to do with them. The local AES cipher passes legacy
 * plaintext through unchanged.
 */
export function wrapSecretEncryptor(encryptor: SecretEncryptor): {
  encrypt(plaintext: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
} {
  return {
    async encrypt(plaintext) {
      return await encryptor.encrypt(plaintext);
    },
    async decrypt(stored) {
      return await encryptor.decrypt(stored);
    },
  };
}

/**
 * Build a {@link SecretCipher}. When `keyB64` is undefined, the cipher acts as
 * a no-op passthrough; the plugin warns at boot when this happens in
 * production-like environments.
 *
 * @param keyB64 - Base64 or base64url-encoded 32-byte AES key.
 * @returns A cipher with `encrypt`, `decrypt`, and `enabled`.
 */
export function createSecretCipher(keyB64: string | undefined | null): SecretCipher {
  if (!keyB64) {
    return {
      encrypt: plaintext => plaintext,
      decrypt: stored => {
        if (stored.startsWith(PREFIX)) {
          throw new WebhookCipherError(
            'cannot decrypt: encrypted secret found but no secretEncryptionKey is configured',
          );
        }
        return stored;
      },
      enabled: false,
    };
  }

  const key = decodeKey(keyB64);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
    },
    decrypt(stored) {
      if (!stored.startsWith(PREFIX)) {
        // Legacy plaintext — pass through. Operators should rotate these
        // values by re-saving the endpoint, which re-encrypts on write.
        return stored;
      }
      const parts = stored.slice(PREFIX.length).split(':');
      if (parts.length !== 3) {
        throw new WebhookCipherError('malformed encrypted secret');
      }
      const [ivB64, ctB64, tagB64] = parts;
      if (!ivB64 || !ctB64 || !tagB64) {
        throw new WebhookCipherError('malformed encrypted secret');
      }
      const iv = Buffer.from(ivB64, 'base64');
      const ct = Buffer.from(ctB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new WebhookCipherError('malformed encrypted secret components');
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    },
    enabled: true,
  };
}
