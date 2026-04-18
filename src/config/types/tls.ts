import type { BunFile } from 'bun';

/**
 * TLS options passed through to Bun.serve().
 * Fields are a subset of Bun's TLSOptions interface.
 * Keep aligned with bun-types on Bun upgrades.
 */
export interface BunTLSConfig {
  key?: string | BunFile;
  cert?: string | BunFile;
  ca?: string | BunFile;
  passphrase?: string;
  /** SNI server name */
  serverName?: string;
  dhParamsFile?: string;
  lowMemoryMode?: boolean;
  /** OpenSSL SSL_OP_* bitmask; use carefully */
  secureOptions?: number;
  /** Reject clients with invalid certificates (mTLS) */
  rejectUnauthorized?: boolean;
  /** Request a client certificate (mTLS) */
  requestCert?: boolean;
}
